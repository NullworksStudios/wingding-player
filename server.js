const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_CMD || 'python -m yt_dlp';

app.use(express.static(path.join(__dirname, 'public')));

function normalizeToUrl(input) {
  if (!input) return null;
  input = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return `https://www.youtube.com/watch?v=${input}`;
  try {
    const u = new URL(input);
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1).split(/[?/]/)[0];
      if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return `https://www.youtube.com/watch?v=${id}`;
    }
    if (u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be')) return input;
  } catch {}
  return null;
}

function runYtDlp(args) {
  // YTDLP may be "python -m yt_dlp" (local win) or "yt-dlp" (docker)
  const parts = YTDLP.split(' ');
  return spawn(parts[0], [...parts.slice(1), ...args], { windowsHide: true });
}

// YouTube bot-checks datacenter IPs ("Sign in to confirm you're not a bot").
// Mitigations: alternate player clients first (override with YT_CLIENTS),
// plus optional login cookies via YT_COOKIES env (Netscape cookies.txt content).
const YT_CLIENTS = process.env.YT_CLIENTS || 'mweb,web_embedded,tv,android_vr,android,web';
let cookieFile = null;
if (process.env.YT_COOKIES) {
  try {
    cookieFile = path.join(os.tmpdir(), 'yt-cookies.txt');
    fs.writeFileSync(cookieFile, process.env.YT_COOKIES);
    console.log('Using YouTube cookies from YT_COOKIES env');
  } catch (e) { console.error('Failed to write cookies file', e); }
}
function baseArgs() {
  const a = ['--no-playlist', '--no-warnings', '--js-runtimes', 'node'];
  if (process.env.YT_VERBOSE === '1') a.push('-v');
  if (YT_CLIENTS) a.push('--extractor-args', `youtube:player_client=${YT_CLIENTS}`);
  if (cookieFile) a.push('--cookies', cookieFile);
  return a;
}

// server/js/server.js:12
app.get('/api/info', (req, res) => {
  const url = normalizeToUrl(req.query.v || req.query.url || '');
  if (!url) return res.status(400).json({ error: 'Provide ?v=VIDEO_ID or ?url=YOUTUBE_URL' });
  const child = runYtDlp(['--dump-single-json', ...baseArgs(), url]);
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  child.on('close', code => {
    if (code !== 0) {
      console.error(err.slice(0, 500));
      return res.status(502).json({ error: 'YouTube fetch failed (private/restricted/rate-limited).' });
    }
    try {
      const j = JSON.parse(out);
      res.json({ id: j.id, title: j.title, author: j.uploader, lengthSeconds: j.duration, thumbnail: j.thumbnail });
    } catch {
      res.status(502).json({ error: 'Parse failed.' });
    }
  });
});

// Live pipe: yt-dlp resolves direct https URLs, ffmpeg copies them into
// fragmented MP4 straight to the browser. First byte in ~3s, no temp file,
// no merge wait. (Old temp-file code measured 4x slower: HLS fetch + merge + faststart.)
function getDirectUrlsOnce(url, format) {
  return new Promise((resolve, reject) => {
    const child = runYtDlp(['-f', format, ...baseArgs(), '-g', url]);
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => {
      if (code !== 0) {
        const trim = process.env.YT_VERBOSE === '1' ? err.slice(-4000) : err.slice(0, 200);
        return reject(new Error('yt-dlp -g exit ' + code + ' ' + trim));
      }
      const urls = out.trim().split('\n').filter(Boolean);
      if (!urls.length) return reject(new Error('no urls'));
      resolve(urls);
    });
    child.on('error', reject);
  });
}
// Flagged datacenter IPs fail intermittently (LOGIN_REQUIRED on some attempts,
// success on others), so retry with a fresh session before giving up.
async function getDirectUrls(url, format, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      if (i > 1) {
        console.log(`[stream] retry ${i}/${attempts} for ${url}`);
        await new Promise(r => setTimeout(r, 2000 * i));
      }
      return await getDirectUrlsOnce(url, format);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
const ALLOWED_H = [144, 240, 360, 480, 720, 1080];
function parseH(req) {
  let h = parseInt(req.query.h, 10);
  if (!ALLOWED_H.includes(h)) h = req.query.q === 'high' ? 480 : 360;
  return h;
}
function formatFor(h) {
  const V = `bv*[height<=${h}][vcodec^=avc][protocol=https]`;
  const A = `ba[acodec^=mp4a][protocol=https]`;
  return `${V}+${A}/bv*[vcodec^=avc][protocol=https]+${A}/b[vcodec^=avc]/b`;
}
// Piped through server so client never touches youtube.com/googlevideo.com.
app.get('/stream', async (req, res) => {
  const url = normalizeToUrl(req.query.v || req.query.url || '');
  if (!url) return res.status(400).send('Missing ?v=VIDEO_ID');
  let h = parseH(req);
  // best at-or-below selected height, strictly H264+AAC over https first;
  // fall back in HEIGHT, not codec (VP9/AV1 in MP4 = browser error 4).
  const format = formatFor(h);
  console.log(`[stream] live ${url} h<=${h} mode=${req.query.mode === 'std' ? 'std' : 'live'}`);
  try {
    const urls = await getDirectUrls(url, format);
    const args = [];
    for (const u of urls.slice(0, 2)) args.push('-i', u);
    if (req.query.mode === 'std') {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k');
    } else {
      args.push('-c', 'copy');
    }
    args.push('-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    const ff = spawn('ffmpeg', ['-y', '-v', 'info', ...args], { windowsHide: true });
    ff.stdout.pipe(res);
    // log input summary once (proves which codecs actually arrived), errors always
    let loggedInput = false;
    ff.stderr.on('data', d => {
      const line = String(d);
      if (!loggedInput && /Input #0|Video:|Audio:/.test(line)) {
        loggedInput = true;
        console.log('[ffmpeg] ' + line.slice(0, 300).replace(/\n/g, ' | '));
      }
      if (/error|fail|denied|forbidden|invalid|unable|could not|timed out|403|404/i.test(line)) {
        console.error('[ffmpeg] ' + line.slice(0, 300));
      }
    });
    ff.on('close', () => { if (!res.writableEnded) res.end(); });
    req.on('close', () => { try { ff.kill(); } catch {} });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(502).send('Stream failed. Try another video.');
  }
});

// Full-download mode: fetch entire video to disk first, report progress,
// then serve the finished file with Range support (seekable everywhere).
const jobs = new Map(); // key -> {state, percent, downBytes, totalBytes, speed}
function dlKey(id, h) { return `${id}-${h}`; }
function dlFile(key) { return path.join(os.tmpdir(), `yt-full-${key}.mp4`); }
function toBytes(s) {
  const m = String(s).match(/([\d.]+)(KiB|MiB|GiB)/);
  if (!m) return null;
  const mult = { KiB: 1024, MiB: 1048576, GiB: 1073741824 }[m[2]];
  return parseFloat(m[1]) * mult;
}
function mb(b) { return b == null ? '?' : (b / 1048576).toFixed(1) + ' MB'; }
function startDownload(id, h, url) {
  const key = dlKey(id, h);
  const file = dlFile(key);
  const cur = jobs.get(key);
  if (cur && cur.state === 'ready' && fs.existsSync(file)) return key;
  if (cur && (cur.state === 'downloading' || cur.state === 'merging')) return key;
  if (!cur && fs.existsSync(file) && fs.statSync(file).size > 1024) {
    const size = fs.statSync(file).size;
    jobs.set(key, { state: 'ready', percent: 100, downBytes: size, totalBytes: size, speed: '', error: '' });
    return key;
  }
  const st = { state: 'downloading', percent: 0, downBytes: 0, totalBytes: null, speed: '', error: '' };
  jobs.set(key, st);
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
  console.log(`[full] downloading ${key}`);
  const child = runYtDlp(['-f', formatFor(h), '--merge-output-format', 'mp4',
    '--postprocessor-args', 'ffmpeg:-movflags faststart',
    ...baseArgs(), '--newline', '--progress', '-o', file, url]);
  let errTail = '';
  child.stderr.on('data', d => { errTail = (errTail + String(d)).slice(-2000); });
  child.stdout.on('data', d => {
    for (const ln of String(d).split('\n')) {
      const m = ln.match(/(\d+(?:\.\d+)?)% of (~?[\d.]+(?:KiB|MiB|GiB)) at ([\d.]+(?:KiB|MiB|GiB)\/s)/);
      if (m) {
        st.percent = parseFloat(m[1]);
        st.totalBytes = toBytes(m[2]);
        st.downBytes = st.totalBytes != null ? st.totalBytes * st.percent / 100 : null;
        st.speed = m[3];
      } else if (ln.includes('[Merger]')) {
        st.state = 'merging';
      }
    }
  });
  child.on('close', code => {
    if (code === 0 && fs.existsSync(file)) {
      const size = fs.statSync(file).size;
      jobs.set(key, { state: 'ready', percent: 100, downBytes: size, totalBytes: size, speed: '', error: '' });
      console.log(`[full] ready ${key} (${mb(size)})`);
    } else {
      const reason = (errTail.match(/ERROR:\s*(.+)/) || [])[1] || ('exit ' + code);
      jobs.set(key, { state: 'error', percent: st.percent || 0, downBytes: null, totalBytes: null, speed: '', error: reason.slice(0, 200) });
      console.error(`[full] failed ${key}: ${reason.slice(0, 300)}`);
    }
  });
  child.on('error', () => jobs.set(key, { state: 'error', percent: 0, downBytes: null, totalBytes: null, speed: '', error: 'spawn failed' }));
  return key;
}
app.get('/download', (req, res) => {
  const url = normalizeToUrl(req.query.v || req.query.url || '');
  if (!url) return res.status(400).json({ error: 'Missing ?v=VIDEO_ID' });
  const m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (!m) return res.status(400).json({ error: 'Bad video id' });
  res.json({ key: startDownload(m[1], parseH(req), url) });
});
app.get('/api/progress', (req, res) => {
  const m = String(req.query.key || '').match(/^([a-zA-Z0-9_-]{11})-(144|240|360|480|720|1080)$/);
  if (!m) return res.status(400).json({ error: 'Bad key' });
  const st = jobs.get(`${m[1]}-${m[2]}`) || { state: 'unknown', percent: 0, downBytes: null, totalBytes: null, speed: '', error: '' };
  res.json({
    state: st.state,
    percent: Math.floor(st.percent || 0),
    downloadedMb: mb(st.downBytes),
    totalMb: mb(st.totalBytes),
    speed: st.speed || '',
    error: st.error || ''
  });
});
app.get('/file', (req, res) => {
  const m = String(req.query.key || '').match(/^([a-zA-Z0-9_-]{11})-(144|240|360|480|720|1080)$/);
  if (!m) return res.status(400).send('Bad key');
  const file = dlFile(`${m[1]}-${m[2]}`);
  if (!fs.existsSync(file)) return res.status(404).send('Not ready');
  const stat = fs.statSync(file);
  const range = req.headers.range;
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  if (range) {
    const r = range.match(/bytes=(\d+)-(\d*)/);
    if (r) {
      const start = parseInt(r[1], 10);
      const end = r[2] ? parseInt(r[2], 10) : stat.size - 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', end - start + 1);
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
  }
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(file).pipe(res);
});
// Drop stale full-download files (>24h) on boot.
try {
  const day = Date.now() - 24 * 3600 * 1000;
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (!f.startsWith('yt-full-') || !f.endsWith('.mp4')) continue;
    const p = path.join(os.tmpdir(), f);
    if (fs.statSync(p).mtimeMs < day) { try { fs.unlinkSync(p); } catch {} }
  }
} catch {}
// Prefetch the featured video on boot so first open plays fast.
const DEFAULT_VIDEO = process.env.DEFAULT_VIDEO || 'liRlUQFbkiI';
const DEFAULT_H = parseInt(process.env.DEFAULT_H, 10) || 360;
try {
  startDownload(DEFAULT_VIDEO, ALLOWED_H.includes(DEFAULT_H) ? DEFAULT_H : 360,
    `https://www.youtube.com/watch?v=${DEFAULT_VIDEO}`);
} catch (e) { console.error('prefetch failed', e); }
app.get('/health', (req, res) => res.json({ ok: true }));


// Server-side YouTube search. Client never touches youtube.com.
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim().slice(0, 100);
  if (!q) return res.status(400).json({ error: 'Provide ?q=QUERY' });
  let n = parseInt(req.query.n, 10);
  if (!Number.isFinite(n)) n = 10;
  n = Math.min(15, Math.max(5, n));
  let o = parseInt(req.query.o, 10);
  if (!Number.isFinite(o)) o = 0;
  o = Math.min(40, Math.max(0, o));
  const total = o + n;
  const child = runYtDlp(['--dump-single-json', '--flat-playlist', ...baseArgs(),
    '--playlist-start', String(o + 1), '--playlist-end', String(total), `ytsearch${total}:${q}`]);
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  child.on('close', code => {
    if (code !== 0) {
      console.error(err.slice(0, 500));
      return res.status(502).json({ error: 'Search failed. Try again.' });
    }
    try {
      const j = JSON.parse(out);
      const results = (j.entries || []).filter(e => e && e.id).map(e => ({
        id: e.id,
        title: e.title,
        author: e.uploader || e.channel || '',
        duration: e.duration || null
      }));
      res.json({ results });
    } catch {
      res.status(502).json({ error: 'Parse failed.' });
    }
  });
});

// Server-side thumbnail proxy so <img> never hits i.ytimg.com directly.
app.get('/thumb', async (req, res) => {
  const v = (req.query.v || '').trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(v)) return res.status(400).send('Bad id');
  try {
    const r = await fetch(`https://i.ytimg.com/vi/${v}/hqdefault.jpg`);
    if (!r.ok) return res.status(502).send('Thumb failed');
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(502).send('Thumb failed');
  }
});
app.listen(PORT, () => console.log(`Listening on ${PORT} (yt-dlp: ${YTDLP})`));
