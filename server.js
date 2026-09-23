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
const YT_CLIENTS = process.env.YT_CLIENTS || 'tv,android,web';
let cookieFile = null;
if (process.env.YT_COOKIES) {
  try {
    cookieFile = path.join(os.tmpdir(), 'yt-cookies.txt');
    fs.writeFileSync(cookieFile, process.env.YT_COOKIES);
    console.log('Using YouTube cookies from YT_COOKIES env');
  } catch (e) { console.error('Failed to write cookies file', e); }
}
function baseArgs() {
  const a = ['--no-playlist', '--no-warnings'];
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
function getDirectUrls(url, format) {
  return new Promise((resolve, reject) => {
    const child = runYtDlp(['-f', format, ...baseArgs(), '-g', url]);
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => {
      if (code !== 0) return reject(new Error('yt-dlp -g exit ' + code + ' ' + err.slice(0, 200)));
      const urls = out.trim().split('\n').filter(Boolean);
      if (!urls.length) return reject(new Error('no urls'));
      resolve(urls);
    });
    child.on('error', reject);
  });
}
// Piped through server so client never touches youtube.com/googlevideo.com.
app.get('/stream', async (req, res) => {
  const url = normalizeToUrl(req.query.v || req.query.url || '');
  if (!url) return res.status(400).send('Missing ?v=VIDEO_ID');
  const allowed = [144, 240, 360, 480, 720, 1080];
  let h = parseInt(req.query.h, 10);
  if (!allowed.includes(h)) h = req.query.q === 'high' ? 480 : 360;
  // best at-or-below selected height, https H264+AAC first (fast direct fetch).
  const format = `bestvideo[height<=${h}][vcodec^=avc][protocol=https]+bestaudio[acodec^=mp4a][protocol=https]/best[height<=${h}][vcodec^=avc][protocol=https]/best[height<=${h}][protocol=https]/best[protocol=https]/best`;
  console.log(`[stream] live ${url} h<=${h}`);
  try {
    const urls = await getDirectUrls(url, format);
    const args = [];
    for (const u of urls.slice(0, 2)) args.push('-i', u);
    args.push('-c', 'copy', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    const ff = spawn('ffmpeg', ['-y', '-v', 'error', ...args], { windowsHide: true });
    ff.stdout.pipe(res);
    ff.stderr.on('data', d => console.error('[ffmpeg] ' + String(d).slice(0, 200)));
    ff.on('close', () => res.end());
    req.on('close', () => { try { ff.kill(); } catch {} });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(502).send('Stream failed. Try another video.');
  }
});

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
