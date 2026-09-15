FROM node:24.19.0-bookworm-slim AS dependencies
WORKDIR /workspace
RUN npm install -g pnpm@10.15.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/email-gateway/package.json apps/email-gateway/package.json
RUN pnpm --filter @bezalel/email-gateway install --frozen-lockfile
COPY apps/email-gateway apps/email-gateway
RUN pnpm --filter @bezalel/email-gateway deploy --legacy --prod /gateway

FROM node:24.19.0-bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends postfix ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /gateway /app
EXPOSE 25 8080
STOPSIGNAL SIGTERM
CMD ["node", "src/start.mjs"]
