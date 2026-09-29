# syntax=docker/dockerfile:1
ARG CLAUDE_VERSION

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS download
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
ARG CLAUDE_VERSION
ARG TARGETARCH
# There is no official armv7 build; its image is rebuilt from the linux-x64 binary, whose
# embedded JavaScript is the same on every platform.
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64|arm) platform=linux-x64 ;; \
      arm64) platform=linux-arm64 ;; \
    esac; \
    release="https://downloads.claude.ai/claude-code-releases/$CLAUDE_VERSION"; \
    curl -fsSL -o /claude "$release/$platform/claude"; \
    checksum=$(curl -fsSL "$release/manifest.json" \
      | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0)).platforms['$platform'].checksum)"); \
    echo "$checksum  /claude" | sha256sum -c -; \
    chmod +x /claude

FROM node:22-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node /workspace
ENV DISABLE_AUTOUPDATER=1
USER node
WORKDIR /workspace
ENTRYPOINT ["claude"]

# Runtime dependencies include node-pty, a native addon built for the target platform against
# an older glibc so the executable runs on older distributions too.
FROM node:22-bullseye AS node-modules
WORKDIR /modules
COPY node/package.json node/package-lock.json ./
# Prebuilt binaries and sources for other platforms are dropped.
RUN npm ci --omit=dev --no-audit --no-fund \
    && rm -rf node_modules/node-pty/prebuilds node_modules/node-pty/third_party node_modules/node-pty/deps

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS node-build
WORKDIR /build
COPY node/package.json node/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY node/ ./
COPY --from=download /claude /claude
RUN node build.mjs /claude /app \
    && cp claude.mjs bun.mjs cell-segmenter.mjs spawn.mjs /app/

# The app is embedded in a single executable application. The blob is prepared on the target
# platform because its layout depends on the platform's word size.
FROM node:22-bookworm-slim AS sea
WORKDIR /sea
COPY node/sea.cjs node/sea-config.mjs ./
COPY --from=node-build /app ./app
COPY --from=node-modules /modules/node_modules ./app/node_modules
RUN node sea-config.mjs app sea.json \
    && node --experimental-sea-config sea.json

FROM node-build AS inject
COPY --from=sea /usr/local/bin/node /claude-executable
COPY --from=sea /sea/sea.blob ./
RUN npx postject /claude-executable NODE_SEA_BLOB sea.blob \
      --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

FROM scratch AS executable
COPY --from=inject /claude-executable /claude

FROM base AS runtime-amd64
COPY --from=download /claude /usr/local/bin/claude

FROM base AS runtime-arm64
COPY --from=download /claude /usr/local/bin/claude

FROM base AS runtime-arm
COPY --from=executable /claude /usr/local/bin/claude
# Extracts the embedded app into the user's cache ahead of the first run.
RUN claude --version

FROM runtime-${TARGETARCH}
