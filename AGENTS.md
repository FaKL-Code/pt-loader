# Release discipline

These rules apply to Codex, Claude and every other contributor working on this
repository:

1. Implement reusable behavior in `@fakl-code/pt-loader`; example projects may
   only integrate the public package API and must not become the source of
   truth for package behavior.
2. Any commit that changes package code, public types, build scripts, CI or
   release behavior must update user-facing documentation (`README.md`,
   `CHANGELOG.md` or `docs/`) in the same commit.
3. Run `npm run check` before committing. Do not commit `dist/`; it is built by
   the package lifecycle scripts and by CI.
4. A merge/push to protected `main` is a release: GitHub Actions publishes the
   next patch version to npm and creates the matching GitHub Release. Never
   publish an untracked local version manually unless recovering a failed CI
   run.
5. The release workflow must keep `NPM_TOKEN` in GitHub Actions secrets and
   must never commit credentials or proprietary game assets.

The CI release-discipline check rejects package changes that do not include a
documentation change. This file is the shared instruction source for both
human and AI contributors.

