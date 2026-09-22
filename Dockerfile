# The open executor.
#
# Two stages so the image does not ship the toolchain. The build stage compiles the SDK and the
# executor to dist/; the runtime stage carries node_modules and dist and nothing else.
#
# The image contains no key and no configuration. Every secret is an environment variable,
# because an image is a thing people copy and a repository is a thing people mirror.
FROM node:22-alpine AS build
WORKDIR /app

# Copied first, and separately, so a source edit does not re-run the install.
COPY package.json package-lock.json ./
COPY sdk/package.json sdk/
COPY executor/package.json executor/
RUN npm ci

COPY sdk/ sdk/
COPY executor/ executor/
RUN npm run build -w @memokit/sdk && npm run build -w @memokit/executor
# Drops devDependencies -- the compilers, the test runner -- from what gets copied on.
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/sdk/dist sdk/dist
COPY --from=build /app/sdk/package.json sdk/package.json
COPY --from=build /app/executor/dist executor/dist
COPY --from=build /app/executor/package.json executor/package.json

# The deployment file the service reads the controller address from when MEMOKIT_CONTROLLER is
# not set. Small, public, and the one piece of state the image legitimately carries.
COPY fixtures/deployment.json fixtures/deployment.json

# The state file lives here. Mount a volume on it, or accept that a restart re-reads the ledger
# and re-derives what it can -- which is safe, just not free. See executor/DEPLOY.md.
ENV STATE_FILE=/data/executor-state.json
VOLUME /data

# Runs as a non-root user that already exists in the base image.
USER node

ENV HTTP_PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:${HTTP_PORT}/healthz || exit 1

CMD ["node", "executor/dist/service/index.js"]
