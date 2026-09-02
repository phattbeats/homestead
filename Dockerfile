# syntax=docker/dockerfile:1.7
# Multi-stage build: install + build native deps in stage 1, copy the
# resulting node_modules into a slim runtime image in stage 2. The
# node-gyp install hook auto-fired by npm needs python3/make/g++ to
# evaluate binding.gyp even when the prebuilt N-API binary is used.
#
# PHA-2640: install git in the deps stage so npm's `prepare` script
# (which runs `npm run hooks:install` → `git config core.hooksPath
# .githooks`, added in PHA-2354) can complete. Without git the
# prepare hook exits 127 and `npm ci` fails — every release from
# v0.3.0.1 through v0.4.3 was silently broken. Adding git here keeps
# the prepare hook as the single source of truth for hook setup.
#
# PHA-2644: install ffmpeg in the deps stage. The media-comprehension
# package uses ffmpeg's scene-change keyframe extraction (`select=gt
# (scene,0.4)`) and whisper-class audio-track extraction
# (`-ac 1 -ar 16000 -acodec pcm_s16le`). Both are required for the
# new `GET /api/media/:id/context` endpoint. ffprobe is bundled with
# the ffmpeg package; no separate install needed. Image without
# ffmpeg would 500 every video comprehension request.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential ca-certificates git ffmpeg \
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
# PHA-2971: release.yml passes --build-arg COMMIT_SHA so /api/version
# (PHA-1706) reports the real deployed commit instead of null. A build-arg
# alone isn't visible to the running process -- it must be promoted to an
# ENV to survive into the container's runtime environment.
ARG COMMIT_SHA
ENV DATA_DIR=/data PORT=3080 NODE_ENV=production COMMIT_SHA=$COMMIT_SHA
VOLUME /data
EXPOSE 3080
CMD ["node", "server.js"]