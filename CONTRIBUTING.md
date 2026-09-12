# Contributing

Thanks for helping improve `@jpstale/pt-loader`.

## Development setup

You need Node.js 18 or newer and npm.

```bash
git clone https://github.com/FaKL-Code/pt-loader.git
cd pt-loader
npm install
npm test
```

The package is pure ESM and ships its source directly, so there is no compile
step. Run `npm run check` before opening a pull request; it executes the full
test suite and validates the npm package contents.

## Project structure

```text
src/io/          binary reader and texture-header decryption
src/formats/     binary parsers; pure data with no three.js dependency
src/build/       parsed data to three.js objects
src/textures/    BMP/TGA decoders and texture cache
src/index.js     high-level PTLoader API
src/viewer.js    ready-made PTViewer canvas
bin/cli.js       pt-assets command-line interface
types/           public TypeScript declarations
test/            synthetic fixtures and integration tests
```

## Pull requests

- Keep `src/formats/` free of three.js imports so parsers remain usable in
  workers and Node.js.
- Add or update a synthetic fixture for binary-layout changes and assert final
  byte offsets.
- Preserve the rendering contracts documented in the README, especially UV
  orientation, non-indexed geometry and material depth/blend behavior.
- Update the TypeScript declarations when changing a public API.
- Do not commit proprietary game assets. Tests must use synthetic fixtures or
  assets you have permission to redistribute.
- Keep changes focused and explain the source-format evidence behind parser
  changes.

Bug reports should include the loader version, runtime, relevant console error
and the output of `pt-assets inspect`. Do not attach copyrighted game assets to
public issues.
