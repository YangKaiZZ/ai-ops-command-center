# syntax=docker/dockerfile:1
# The API server, with the MCP server inside: the agent starts the MCP server
# as a subprocess (MCP_SERVER_PATH), so both have to be in this image. The MCP
# code comes from its own repo as a second build context named "mcp":
#
#   docker build --build-context mcp=../ai-ops-mcp -t ai-ops-backend .
#
# (ai-ops-deploy's docker-compose.yml passes it for you.)
FROM node:24-slim

# MCP server: only its code and lockfile. Its .env (a seller's API key for
# Claude Desktop) stays out; the backend hands it a token per agent run.
WORKDIR /mcp
COPY --from=mcp package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=mcp *.js ./

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY schema.sql ./
COPY scripts ./scripts
COPY src ./src

ENV NODE_ENV=production \
    PORT=3000 \
    MCP_SERVER_PATH=/mcp/server.js
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://localhost:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Bring the database up to date (safe to repeat), then serve.
CMD ["sh", "-c", "node scripts/migrate.js && exec node src/server.js"]
