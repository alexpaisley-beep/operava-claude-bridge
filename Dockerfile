# Operava Claude Bridge — single image, two services.
# claude-bridge-api:    node dist/api/main.js     (default CMD)
# claude-bridge-worker: node dist/worker/main.js  (override start command)

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY package.json ./

# Non-root runtime user; /data holds workspaces + the durable Claude home
# (mount a Railway volume at /data on the worker service).
RUN useradd --create-home bridge \
    && mkdir -p /data \
    && chown -R bridge:bridge /data /app
USER bridge
ENV WORKSPACE_ROOT=/data/workspaces \
    CLAUDE_HOME_DIR=/data/claude-home

EXPOSE 8080
CMD ["node", "dist/api/main.js"]
