# TT Trading Desk — single image that builds everything and serves the API +
# the desk web app from one process/port.
FROM node:20-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Build tools for better-sqlite3 (prebuilds usually cover it; kept for safety),
# plus git + the Docker CLI/compose plugin so the in-app "Update" button can
# pull and rebuild via the mounted Docker socket (opt-in, see docker-compose.yml).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl gnupg git \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
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
