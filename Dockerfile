# syntax=docker/dockerfile:1.7
# Multi-stage build: install + build native deps in stage 1, copy the
# resulting node_modules into a slim runtime image in stage 2. The
# node-gyp install hook auto-fired by npm needs python3/make/g++ to
# evaluate binding.gyp even when the prebuilt N-API binary is used.
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
# Run as the unprivileged "node" user that ships with the official image.
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public
ENV DATA_DIR=/data PORT=3080 NODE_ENV=production
VOLUME /data
EXPOSE 3080
USER node
CMD ["node", "server.js"]