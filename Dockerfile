# Container image for @atlasent/mcp-server (stdio transport by default).
#
# Also the build Glama uses to start the server and introspect its tools
# (glama.ai/mcp/servers). With no ATLASENT_API_KEY / ATLASENT_BASE_URL the
# server resolves to LOCAL mode, so `tools/list` works without credentials.
# Local-mode permits are unsigned: development and evaluation only.
#
#   docker build -t atlasent-mcp .
#   docker run -i --rm atlasent-mcp                                  # local mode
#   docker run -i --rm -e ATLASENT_API_KEY -e ATLASENT_BASE_URL atlasent-mcp   # remote
#   docker run --rm -p 3333:3333 -e ATLASENT_MCP_TRANSPORT=streamable-http \
#     -e ATLASENT_MCP_HTTP_HOST=0.0.0.0 -e ATLASENT_MCP_HTTP_BEARER=... atlasent-mcp

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY LICENSE NOTICE ./
USER node
ENTRYPOINT ["node", "dist/index.js"]
