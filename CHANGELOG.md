# Changelog

All notable changes to this project will be documented in this file. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `PTPreviewViewer`, a reusable interaction layer for private, server-rendered
  previews. It owns pointer capture, native image-drag prevention,
  orbit/pan/zoom controls, stale-session protection and frame coalescing.

### Changed

- The example integration now consumes the package preview abstraction instead
  of duplicating browser interaction code.
- Pushes to `main` now create a matching GitHub Release after publishing the
  patch version to npm.
- npm publishing uses trusted provenance attestations through the workflow's
  `id-token` permission.
- Added a release-discipline check requiring documentation changes alongside
  package, type, build or CI changes.
- The local release-discipline check now includes staged and working-tree
  changes, matching the enforcement performed in CI.

## [0.1.2] - 2026-09-11

### Changed

- Renamed the npm package scope to `@fakl-code/pt-loader`.
- Added automated publishing for version tags through GitHub Actions.

## [0.1.1] - 2026-09-11

### Added

- Per-request credentials and authorization headers for protected assets.
- Minified production bundles without source maps or published source files.
- Retry behavior after asset authorization failures and package-content checks.

## [0.1.0] - 2026-09-11

### Added

- Pure ESM loaders for PAT3D models, STAGE3D maps, SMB skeletons and INX motion
  indices.
- BMP and TGA decoding, including the header obfuscation used by game assets.
- three.js builders for static meshes, maps, skeletons and animation clips.
- `PTLoader` high-level API and the batteries-included `PTViewer`.
- Surface picking, shared-texture discovery and animated highlight overlays.
- Collision-only geometry extraction.
- Optional Web Worker parsing for large maps.
- `pt-assets` CLI for inspection, decryption, texture conversion and manifest
  generation.
- TypeScript declarations and a 68-test suite.

[Unreleased]: https://github.com/FaKL-Code/pt-loader/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/FaKL-Code/pt-loader/releases/tag/v0.1.2
[0.1.1]: https://github.com/FaKL-Code/pt-loader/releases/tag/v0.1.1
[0.1.0]: https://github.com/FaKL-Code/pt-loader/releases/tag/v0.1.0
