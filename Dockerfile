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

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS node-build
WORKDIR /build
COPY node/package.json node/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY node/ ./
COPY --from=download /claude /claude
RUN node build.mjs /claude /out \
    && npm prune --omit=dev \
    && cp -r node_modules claude.cjs bun.cjs /out/

FROM node:22-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node /workspace
ENV DISABLE_AUTOUPDATER=1 \
    USE_BUILTIN_RIPGREP=0

FROM base AS runtime-amd64
COPY --from=download /claude /usr/local/bin/claude

FROM base AS runtime-arm64
COPY --from=download /claude /usr/local/bin/claude

# The rebuilt app lives where Bun serves its embedded files, so the paths it computes for
# them resolve unchanged.
FROM base AS runtime-arm
COPY --from=node-build /out /\$bunfs/root
RUN ln -s '/$bunfs/root/claude.cjs' /usr/local/bin/claude

FROM runtime-${TARGETARCH}
USER node
WORKDIR /workspace
ENTRYPOINT ["claude"]
