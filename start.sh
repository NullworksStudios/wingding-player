#!/bin/sh
# Start the PO token provider (yt-dlp plugin auto-connects at 127.0.0.1:4416), then the app.
node /opt/pot-server/server/build/main.js &
for i in $(seq 1 30); do
  if curl -s -o /dev/null http://127.0.0.1:4416/; then break; fi
  sleep 1
done
exec node server.js
