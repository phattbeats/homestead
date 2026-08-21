# syntax=docker/dockerfile:1.7
# Multi-stage build: install + build native deps in stage 1, copy the
# resulting node_modules into a slim runtime image in stage 2. The
# node-gyp install hook auto-fired by npm needs python3/make/g++ to
# evaluate binding.gyp even when the prebuilt N-API binary is used.

# OpenContainers image labels (PHA-2222). The license label must agree
# with the LICENSE file at repo root (AGPL-3.0-or-later) and the
# `license` field in package.json. These labels are inherited by the
# runtime stage below because they live before the first FROM.
LABEL org.opencontainers.image.title="homestead" \
      org.opencontainers.image.description="Shared life app: tasks with take-turns rotation, calendar, and a full-screen iframe app shell for self-hosted services." \
      org.opencontainers.image.source="https://github.com/phattbeats/homestead" \
      org.opencontainers.image.url="https://github.com/phattbeats/homestead" \
      org.opencontainers.image.documentation="https://github.com/phattbeats/homestead#readme" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.vendor="PHATT Tech LLC" \
      org.opencontainers.image.authors="PHATT Tech LLC"

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

FROM node:22-bookworm-slim
WORKDIR /app
# Run as root. The bind-mounted /data volume on Unraid (and most hosts) is
# owned by UID 99 ("nobody") with mode 0775, so the official image's
# unprivileged "node" user (UID 1000) cannot create life.db inside it and
# the container fails with SQLITE_CANTOPEN on boot. Root inside a single-
# purpose app container with no exposed shell is fine for this use case.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
# lib/ holds the runtime modules (lib/user-model, lib/sync/plex,
# lib/sync/kavita, lib/calendar-sources, lib/graph-source, lib/dedup,
# lib/health-checker, lib/secret-box, lib/snapshot, lib/agent-tokens,
# lib/agent-endpoints, lib/drawer-dispatcher, lib/media). server.js
# requires './lib/user-model' at boot, so dropping this directory in
# the runtime stage leaves the container unable to start with
# `Error: Cannot find module './lib/user-model'` (PHA-2001).
COPY lib ./lib
COPY public ./public
ENV DATA_DIR=/data PORT=3080 NODE_ENV=production
VOLUME /data
EXPOSE 3080
CMD ["node", "server.js"]