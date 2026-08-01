# TT Trading Desk — single image that builds everything and serves the API +
# the desk web app from one process/port.
FROM node:20-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Build tools for better-sqlite3 (prebuilds usually cover it; kept for safety).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4000
ENV DB_PATH=/data/tttrading.sqlite
ENV WEB_DIST=/app/apps/web/dist

EXPOSE 4000
VOLUME ["/data"]

CMD ["pnpm", "start"]
