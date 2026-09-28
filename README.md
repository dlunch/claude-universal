# claude-universal

Docker images of [Claude Code](https://code.claude.com) for `linux/amd64`, `linux/arm64` and
`linux/arm/v7`, rebuilt daily from the latest release.

```sh
docker run -it --rm \
  -v claude-home:/home/node \
  -v "$PWD:/workspace" \
  ghcr.io/dlunch/claude-universal
```

The `claude-home` volume keeps the login and settings between runs. Tags are `latest` and the
Claude Code version (for example `2.1.284`).

## How it works

- **amd64, arm64**: the official native binary, verified against the release manifest checksum.
- **armv7**: Anthropic publishes no 32-bit build, so the image runs the application on Node.js 22.
  [`node/build.mjs`](node/build.mjs) reads the module table that Bun appends to the official
  binary, bundles the embedded JavaScript with esbuild, and writes the embedded assets under
  `/$bunfs/root`, the path the app expects them at. [`node/claude.cjs`](node/claude.cjs) serves
  those assets through Node module hooks and [`node/bun.cjs`](node/bun.cjs) provides the Bun
  APIs the app calls without a Node fallback.

The workflow in [`.github/workflows/build.yml`](.github/workflows/build.yml) checks the latest
release every day and publishes images for versions not built yet.
