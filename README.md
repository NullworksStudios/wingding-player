# WingDing Player (Railway)

Your browser only talks to this server. The server fetches YouTube with yt-dlp and pipes video back.
This avoids client-side `youtube.com / googlevideo.com` DNS + SNI blocks, as long as your Railway domain itself is not blocked.

## Run locally
```
npm install
pip install -r requirements.txt
node server.js
# open http://localhost:3000
```

## Deploy on Railway
1. Push this folder to GitHub.
2. Railway -> New Project -> Deploy from Repo.
3. Railway auto-detects the `Dockerfile` (node + python + ffmpeg + yt-dlp). No extra config needed.
4. Open the Railway-provided `https://xxx.up.railway.app` URL on the restricted WiFi.

## Notes / limits
- Bandwidth: video is proxied through Railway. Default 360p; pick 144p–1080p in the sidebar (higher = more egress).
- Railway bot-check: YouTube often shows "Sign in to confirm you're not a bot" to datacenter IPs.
  The server defaults to the `android` player client (`YT_CLIENTS` env, e.g. `android,web`)
  which usually avoids it. If it still fails, add login cookies:
  1. In your desktop browser install "Get cookies.txt LOCALLY", export `youtube.com` cookies.
  2. Railway → Variables → add `YT_COOKIES` with the full file content → redeploy.
  Refresh cookies when streams start failing again.
- YouTube rate-limits datacenter IPs and changes parsing often. If `/api/info` returns 502, redeploy to get latest yt-dlp (`pip install -U yt-dlp` in Dockerfile build does this).
- Only use for content you have the right to view, and only on networks where you have permission. Circumventing school/work filters may violate acceptable-use policy. Respect YouTube ToS and copyright.
