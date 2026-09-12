# Governance

`pt-loader` is maintained by [@FaKL-Code](https://github.com/FaKL-Code), who is
the repository owner and final decision maker for project direction, releases,
and security response.

## Contribution flow

All community changes target `main` through a pull request. The protected branch
requires:

- a successful CI run on every supported Node.js version;
- all review conversations to be resolved;
- an approving review from the code owner;
- a branch that is up to date with `main`.

Reviews may request tests, documentation, smaller scope, or format evidence.
Approval is based on technical quality, compatibility, maintainability, legal
redistributability, and alignment with the project's scope.

Accepted pull requests are squash-merged. The pull-request title should
therefore be concise and suitable for the permanent commit history. Branches
are deleted automatically after merge.

## Decisions and releases

Design discussions happen in GitHub Discussions or in a focused issue before a
large implementation begins. The maintainer may close proposals that conflict
with the package's architecture or asset-distribution policy.

Releases are created from reviewed commits on `main`, use semantic versioning,
and are documented in `CHANGELOG.md`. Security matters follow `SECURITY.md` and
must be reported privately.
