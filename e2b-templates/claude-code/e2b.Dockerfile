# Minimal E2B template for Claude Code with WebSocket streaming
FROM ubuntu:22.04

# Install Node.js, Python, build tools, Claude Code
RUN sed -i 's|http://archive.ubuntu.com/ubuntu|http://ubuntu.mirror.constant.com/ubuntu|g; s|http://security.ubuntu.com/ubuntu|http://ubuntu.mirror.constant.com/ubuntu|g' /etc/apt/sources.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    bsdutils \
    net-tools \
    python3 \
    python3-pip \
    make \
    g++ \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g @anthropic-ai/claude-code \
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

# Create user directory (E2B uses uid 1000)
RUN mkdir -p /home/user && chown 1000:1000 /home/user

# Copy WebSocket server script
COPY ws-server.mjs /home/user/ws-server.mjs
RUN chmod +x /home/user/ws-server.mjs && chown 1000:1000 /home/user/ws-server.mjs

# Copy CLAUDE.md for project instructions (Claude Code reads this automatically)
COPY CLAUDE.md /home/user/CLAUDE.md
RUN chown 1000:1000 /home/user/CLAUDE.md

# Install ws + node-pty from local package.json for reproducible builds
COPY package.json /home/user/package.json
WORKDIR /home/user
RUN npm install && chown -R 1000:1000 /home/user

# Set working directory
WORKDIR /home/user
