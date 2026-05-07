# Minimal E2B template for Codex CLI with WebSocket streaming.
FROM ubuntu:22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    net-tools \
    python3 \
    python3-pip \
    make \
    g++ \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g @openai/codex \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /home/user && chown 1000:1000 /home/user

COPY ws-server.mjs /home/user/ws-server.mjs
COPY package.json /home/user/package.json
RUN chmod +x /home/user/ws-server.mjs && chown 1000:1000 /home/user/ws-server.mjs /home/user/package.json

WORKDIR /home/user
RUN npm install && chown -R 1000:1000 /home/user

WORKDIR /home/user
