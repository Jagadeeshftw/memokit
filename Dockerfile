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

# su-exec drops privileges in the entrypoint after it has fixed the volume's ownership.
RUN apk add --no-cache su-exec

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/sdk/dist sdk/dist
COPY --from=build /app/sdk/package.json sdk/package.json
COPY --from=build /app/executor/dist executor/dist
COPY --from=build /app/executor/package.json executor/package.json

# Load the whole module graph at build time, so a resolution break fails the build rather than
# the boot. Importing the entrypoint does not start the service: it runs `main()` only when it
# is the process entry, which it is not here.
#
# This is here because it has already earned its place. Something in the Foundry-side toolchain
# depends on ethers 5, and npm was free to hoist that one to the root, where the copied
# node_modules put it in front of the ethers 6 the SDK actually imports. The container died at
# boot with:
#
#   SyntaxError: Named export 'AbiCoder' not found. The requested module 'ethers' is a
#   CommonJS module, which may not support all module.exports as named exports.
#
# Invisible in every local run, because those go through tsx and resolve from the workspace.
# The root package.json now names ethers ^6 itself so the hoisted copy is the right one, and
# this check is what proves it on every build instead of trusting it.
RUN node --input-type=module -e "await import('/app/executor/dist/service/index.js'); console.log('module graph ok')"

# The deployment file the service reads the controller address from when MEMOKIT_CONTROLLER is
# not set. Small, public, and the one piece of state the image legitimately carries.
COPY fixtures/deployment.json fixtures/deployment.json

# The state file lives here. Mount a volume on it, or accept that a restart re-reads the ledger
# and re-derives what it can -- which is safe, just not free. See executor/DEPLOY.md.
#
# Deliberately no `VOLUME /data`: Railway refuses a Dockerfile that declares one
# ("docker VOLUME at Line 41 is not supported, use Railway Volumes") because it attaches
# storage itself. The directory is created below so the path exists either way -- Railway
# mounts over it, `docker run -v` mounts over it, and a run with neither still starts and
# writes to the container's own filesystem, which is ephemeral but not broken.
ENV STATE_FILE=/data/executor-state.json
RUN mkdir -p /data && chown node:node /data

# Starts as root so the entrypoint can take ownership of the mounted volume, then drops to the
# non-root `node` user before the service itself runs. A process that executes instructions
# written by strangers has no business being root.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

ENV HTTP_PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:${HTTP_PORT}/healthz || exit 1

CMD ["node", "executor/dist/service/index.js"]
