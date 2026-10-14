FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /srv

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY packages/mcp/src ./packages/mcp/src
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "packages/mcp/src/http-entry.ts"]
