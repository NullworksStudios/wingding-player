FROM node:20-slim
RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt
COPY . .
ENV PORT=3000
ENV YTDLP_CMD=yt-dlp
EXPOSE 3000
CMD ["node", "server.js"]
