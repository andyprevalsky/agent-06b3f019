# Minimal E2B template for Codex CLI with WebSocket streaming.
FROM ubuntu:22.04

ARG CODEX_VERSION=0.144.1

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
    && npm install -g "@openai/codex@$CODEX_VERSION" \
    && rm -rf /var/lib/apt/lists/*

# rose-ui screenshot/record/perf/check (~/.rose/bin/rose-ui, installed per session):
# headless Chromium through playwright-core, ffmpeg for MP4 recordings, and fonts
# so screenshots render text and emoji. Browsers live outside $HOME for uid 1000.
ARG PLAYWRIGHT_CORE_VERSION=1.64.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-noto-core \
    fonts-noto-color-emoji \
    && npm install -g "playwright-core@$PLAYWRIGHT_CORE_VERSION" \
    && playwright-core install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /home/user && chown 1000:1000 /home/user

COPY ws-server.mjs /home/user/ws-server.mjs
COPY package.json /home/user/package.json
RUN chmod +x /home/user/ws-server.mjs && chown 1000:1000 /home/user/ws-server.mjs /home/user/package.json

WORKDIR /home/user
RUN npm install && chown -R 1000:1000 /home/user

WORKDIR /home/user
