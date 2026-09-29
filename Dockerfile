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
ENV DISABLE_AUTOUPDATER=1 \
    USE_BUILTIN_RIPGREP=0
USER node
WORKDIR /workspace
ENTRYPOINT ["claude"]

# The executable is the target platform's node with the launcher injected as a single
# executable application. The blob layout depends on the platform's word size.
FROM node:22-bookworm-slim AS sea
WORKDIR /sea
COPY node/sea.cjs node/sea.json ./
RUN node --experimental-sea-config sea.json

# Runtime dependencies include node-pty, a native addon built for the target platform.
FROM node:22-bookworm AS node-modules
WORKDIR /modules
COPY node/package.json node/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS node-build
WORKDIR /build
COPY node/package.json node/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY node/ ./
COPY --from=download /claude /claude
COPY --from=sea /usr/local/bin/node /out/claude
COPY --from=sea /sea/sea.blob ./
RUN node build.mjs /claude /out/root \
    && npx postject /out/claude NODE_SEA_BLOB sea.blob \
      --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
    && cp claude.mjs bun.mjs cell-segmenter.mjs spawn.mjs /out/root/

FROM base AS runtime-amd64
COPY --from=download /claude /usr/local/bin/claude

FROM base AS runtime-arm64
COPY --from=download /claude /usr/local/bin/claude

# The rebuilt app lives where Bun serves its embedded files, so the paths it computes for
# them resolve unchanged.
FROM base AS runtime-arm
COPY --from=node-build /out/root /\$bunfs/root
COPY --from=node-modules /modules/node_modules /\$bunfs/root/node_modules
COPY --from=node-build /out/claude /usr/local/bin/claude

FROM runtime-${TARGETARCH}
