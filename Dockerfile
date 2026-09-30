# syntax=docker/dockerfile:1
# Scalo — production image: one container runs the API, the background worker and serves the built web app.
#   docker build -t scalo .
# The ee/ directory (Enterprise edition, commercial license) is included when it is present in the build context and
# stays inactive without a license key; delete it (or set SCALO_DISABLE_EE=1 at runtime) for a pure AGPL image.
ARG NODE_VERSION=22

# ---------- build: web app (Vite) ----------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
# ee/ is optional: the runtime stage copies the directory, so make sure it exists
RUN mkdir -p ee && npm run build -w web

# ---------- runtime ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY web/package.json web/
# Only the API and shared workspaces (no React / Vite / Tailwind), without dev dependencies. The API runs its
# TypeScript sources with tsx, a runtime dependency of the api workspace.
RUN npm ci --workspace=api --workspace=shared --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY --from=build /app/shared ./shared
COPY --from=build /app/api/src ./api/src
COPY --from=build /app/api/tsconfig.json ./api/tsconfig.json
COPY --from=build /app/ee ./ee
COPY --from=build /app/web/dist ./web/dist
COPY LICENSE ./

# uploads (media library, lesson files) live in a volume; the process runs as the unprivileged `node` user
RUN mkdir -p /data/uploads && chown -R node:node /data
ENV API_PORT=4000 \
    UPLOAD_DIR=/data/uploads \
    WEB_DIST=/app/web/dist
VOLUME ["/data/uploads"]
EXPOSE 4000
USER node
WORKDIR /app/api

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/index.ts"]
