# Minimal E2B template for Claude Code with WebSocket streaming
FROM ubuntu:22.04

# Install Node.js, Python, build tools, Claude Code
RUN apt-get update && apt-get install -y --no-install-recommends \
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

# Create user directory (E2B uses uid 1000)
RUN mkdir -p /home/user && chown 1000:1000 /home/user

# Copy WebSocket server script
COPY ws-server.mjs /home/user/ws-server.mjs
RUN chmod +x /home/user/ws-server.mjs && chown 1000:1000 /home/user/ws-server.mjs

# Copy CLAUDE.md for project instructions (Claude Code reads this automatically)
COPY CLAUDE.md /home/user/CLAUDE.md
RUN chown 1000:1000 /home/user/CLAUDE.md

# Install ws + node-pty locally in /home/user
WORKDIR /home/user
RUN npm init -y && npm install ws node-pty && chown -R 1000:1000 /home/user

# Set working directory
WORKDIR /home/user
