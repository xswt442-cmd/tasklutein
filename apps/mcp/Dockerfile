FROM node:24-slim

# Optional: build with a different npm registry (NPM_CONFIG_REGISTRY build arg).
ARG NPM_CONFIG_REGISTRY

ENV NODE_ENV=production
WORKDIR /srv

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund ${NPM_CONFIG_REGISTRY:+--registry="$NPM_CONFIG_REGISTRY"}

COPY apps/mcp/src ./apps/mcp/src
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "apps/mcp/src/http-entry.ts"]
