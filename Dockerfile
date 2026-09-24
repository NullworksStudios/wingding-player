FROM node:24-slim
# python/ffmpeg for yt-dlp + streaming, git/build tools + cairo for the POT provider server build
RUN apt-get update && apt-get install -y \
  python3 python3-pip ffmpeg curl git ca-certificates \
  build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt
# PO token provider server (signs googlevideo URLs so SABR-enforced formats don't 403)
RUN git clone --single-branch --branch 2.0.0 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/pot-server \
  && cd /opt/pot-server/server && npm ci && npx tsc
COPY . .
ENV PORT=3000
ENV YTDLP_CMD=yt-dlp
EXPOSE 3000
CMD ["sh", "start.sh"]
