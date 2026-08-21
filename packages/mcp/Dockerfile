# quick-html-share-mcp — stdio MCP server
#
# Standalone Dockerfile (built with plain npm) so this package can be built
# outside the bun workspace, e.g. by third-party MCP directories (Glama)
# that clone just this repo and build from the Dockerfile they find here.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.docker.json ./
COPY src ./src
RUN npx tsc -p tsconfig.docker.json

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist

ENTRYPOINT ["node", "dist/index.js"]
