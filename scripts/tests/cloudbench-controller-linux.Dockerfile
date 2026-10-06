FROM node:22.13.0-bookworm-slim AS node
FROM python:3.11.9-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git procps ripgrep libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
