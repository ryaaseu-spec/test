FROM node:22-bookworm-slim

# Java (for Lavalink) + curl
RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-17-jre-headless curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Lavalink 4.2.2 (4.2.0+ is needed for DAVE voice encryption)
RUN mkdir -p /opt/Lavalink \
 && curl -fsSL -o /opt/Lavalink/Lavalink.jar \
    https://github.com/lavalink-devs/Lavalink/releases/download/4.2.2/Lavalink.jar
COPY application.yml /opt/Lavalink/application.yml

# The bot
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js ./

COPY start.sh ./
RUN chmod +x start.sh

# Lavalink runs inside the same container
ENV LAVALINK_HOST=127.0.0.1
ENV LAVALINK_PORT=2333

CMD ["./start.sh"]
