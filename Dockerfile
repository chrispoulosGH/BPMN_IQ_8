# BPMN IQ — one container: the Express API serves the built React client.
#
#   docker build -t bpmn-iq .
#   docker run -p 8080:3001 -e MONGO_URI=... bpmn-iq
#
# Configuration is environment variables only (no .env in the image): see
# deploy/azure/README.md. The mock production environment (mockprod/) is a
# separate Docker Compose stack and is not part of this image.

# ── 1. Client build (tsc --noEmit && vite build) ──────────────────────────────
FROM node:22.17.0-alpine AS client
WORKDIR /app/client
COPY client/package.json client/yarn.lock ./
RUN yarn install --frozen-lockfile --network-timeout 600000
COPY client/ ./
RUN yarn build

# ── 2. Server production dependencies ─────────────────────────────────────────
FROM node:22.17.0-alpine AS server-deps
WORKDIR /app/server
COPY server/package.json server/yarn.lock ./
RUN yarn install --frozen-lockfile --production --network-timeout 600000

# ── 3. Runtime ────────────────────────────────────────────────────────────────
FROM node:22.17.0-alpine
# Commit the image was built from; /api/health reports it so a deploy can confirm it is live.
ARG GIT_SHA=unknown
ENV APP_VERSION=$GIT_SHA \
    NODE_ENV=production \
    PORT=3001 \
    CLIENT_DIST=/app/client/dist \
    BPMN_FILES_DIR=/data/bpmn-files
WORKDIR /app/server
COPY --chown=node:node --from=server-deps /app/server/node_modules ./node_modules
COPY --chown=node:node server/ ./
COPY --chown=node:node --from=client /app/client/dist /app/client/dist
# BPMN_FILES_DIR: mount persistent storage here (Azure Files) — container disk is ephemeral.
RUN mkdir -p /data/bpmn-files && chown node:node /data /data/bpmn-files
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD wget -qO- http://127.0.0.1:3001/api/health || exit 1
CMD ["node", "index.js"]
