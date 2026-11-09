# Minimal E2B template for Claude Code with WebSocket streaming
FROM ubuntu:22.04

# Opus 5.5 requires CLI >= 2.1.280; pin every template size reproducibly.
ARG CLAUDE_CODE_VERSION=2.1.305
ARG NODE_VERSION=22.23.4

# gh (GitHub CLI) comes from GitHub's own signed apt repository so code agents can run
# `gh pr list` / `gh api` against the attached repo. The repository publishes only the
# latest release, so the version is not pinned here; the sized-template verify step
# records the installed version. No credential is baked into the image: gh reads
# GITHUB_TOKEN / GH_TOKEN from the session environment at run time.
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
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y "nodejs=${NODE_VERSION}-1nodesource1" \
    && install -d -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && gh --version \
    && npm install -g "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION" \
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
