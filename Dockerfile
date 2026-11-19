# Jimeng Video Downloader — Docker image for Render (free tier).
#
# Build:   docker build -t jimeng-downloader .
# Run:     docker run -p 3000:10000 -e PORT=10000 jimeng-downloader
# (On Render, PORT is set automatically — you do not set it yourself.)
#
# Two stages: the first builds the React client (needs the dev
# dependencies: TypeScript, Tailwind); the second is the small runtime
# image — just Bun + the server + the built client. The server itself
# has zero npm runtime dependencies (only node built-ins and bun:sqlite).

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:client

FROM oven/bun:1-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY --from=build /app/public ./public
COPY server ./server
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data
EXPOSE 10000
CMD ["bun", "run", "server/server.ts"]
