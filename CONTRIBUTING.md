# Contributing

Pull requests are open to collaborators only. Only a user with write access to this repository can open one. To work on the code as a collaborator, contact the owner.

Every path has one code owner, @minsu-kang (`.github/CODEOWNERS`). A pull request needs the owner's review before it merges into `main`.

## Before you open a pull request

- Run `pnpm check`. It runs the linter, the type check and every test, and it must pass.
- Keep a change to one purpose, and add or update the tests that prove it.
- Read `AGENTS.md` and the `AGENTS.md` of each package you change. They list the rules that tests enforce and the things that are easy to break.
- By opening a pull request you agree that your contribution is licensed under the MIT License of this repository.
- Do not commit secrets, real receipts or personal data. The evaluation data is synthetic, and the folders `packages/eval/results/` and `apps/desktop/release/` stay out of git.

## Pull request titles and releases

Write the title of a pull request in the Conventional Commits form, for example `feat: add a node` or `fix: keep the focus on a disabled control`. The allowed types are feat, fix, docs, style, refactor, perf, test, build, ci, chore and revert, and `.github/workflows/pr-validate.yml` checks the title. Merge with "Squash and merge", so that the title becomes the commit message.

release-please reads those commit messages. It keeps a release pull request open on `main`, with the next version and the changelog. The `feat` and `fix` changes and the breaking changes decide the version, and while the version is below 1.0.0 a breaking change raises the minor number. Merging the release pull request creates the tag `vX.Y.Z` and a GitHub Release, and `.github/workflows/release-please.yml` builds the macOS app (Apple Silicon, signed ad hoc, not notarized) and attaches it to that release. The version is written to `package.json` and to `apps/desktop/package.json`. Commits up to the first push are ignored (`bootstrap-sha` in `release-please-config.json`), and the first release is version 0.1.0. Its release pull request opens with the first `feat` or `fix` change that is merged after that.

## Repository settings (owner)

These settings live on GitHub, not in the repository, so no file can enforce them. Set them once, after the first push:

1. Settings, General, Features, Pull requests: choose "Collaborators only".
2. Settings, Rules, Rulesets: add a ruleset for the default branch that requires a pull request and a review from code owners, blocks force pushes and deletion, and requires the CI jobs (`lint`, `typecheck`, `unit` and `build`) to pass. Let the owner bypass it, because a sole owner cannot approve their own pull request.
3. Settings, General, Pull Requests: allow squash merging only, and set its default message to the pull request title.
4. Settings, Actions, General, Workflow permissions: allow GitHub Actions to create and approve pull requests, which release-please needs.

A release pull request is opened with the default token, so the CI jobs do not run on it. The owner merges it with the bypass.
