# claude-universal

Builds [Claude Code](https://code.claude.com) for `linux/amd64`, `linux/arm64` and
`linux/arm/v7` from the official release. Nothing built here is published: the build downloads
Anthropic's binary, so build it yourself for your own use.

```sh
version=$(curl -fsSL https://downloads.claude.ai/claude-code-releases/latest)
docker buildx build --platform linux/arm/v7 --build-arg CLAUDE_VERSION=$version -t claude --load .
docker run -it --rm -v claude-home:/home/node -v "$PWD:/workspace" claude
```

The `claude-home` volume keeps the login and settings between runs.

## Standalone armv7 executable

The armv7 build is a single executable that also runs outside Docker on 32-bit ARM Linux with
glibc 2.28 or newer. It needs `libatomic1` and uses the system `rg` (ripgrep). The first run
extracts the app into `~/.cache/claude-universal`.

```sh
docker buildx build --platform linux/arm/v7 --build-arg CLAUDE_VERSION=$version \
  --target executable --output type=local,dest=. .
install -m 755 claude ~/.local/bin/claude
```

## How it works

- **amd64, arm64**: the official native binary, verified against the release manifest checksum.
- **armv7**: Anthropic publishes no 32-bit build, so the image runs the application on Node.js 22.
  [`node/build.mjs`](node/build.mjs) reads the module table that Bun appends to the official
  binary, bundles the embedded JavaScript with esbuild, and writes the embedded assets next to
  it, rewriting the `/$bunfs/root/` paths the app spells out. [`node/claude.mjs`](node/claude.mjs) serves
  those assets through Node module hooks and [`node/bun.mjs`](node/bun.mjs) provides the Bun
  APIs the app calls without a Node fallback, including a JavaScript implementation of the
  native terminal cell renderer ([`node/cell-segmenter.mjs`](node/cell-segmenter.mjs)) and
  pseudo-terminals for background sessions on node-pty ([`node/spawn.mjs`](node/spawn.mjs)).
  `claude` is a Node single executable application that embeds all of this, so like Bun's
  standalone binary it is its own `process.execPath`.

The workflow in [`.github/workflows/build.yml`](.github/workflows/build.yml) builds the latest
release on every push and runs [`test/compare.sh`](test/compare.sh) without publishing anything:
against a mock Messages API, the armv7 image must answer
a prompt that runs a Bash tool call both headless and as a background session, and render an
interactive session identically to the official amd64 binary.
