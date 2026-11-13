# Contributing

Pull requests are open to collaborators only. Only a user with write access to this repository can open one. To work on the code as a collaborator, contact the owner.

Every path has one code owner, @minsu-kang (`.github/CODEOWNERS`). A pull request needs the owner's review before it merges into `main`.

## Before you open a pull request

- Run `pnpm check`. It runs the linter, the type check and every test, and it must pass.
- Keep a change to one purpose, and add or update the tests that prove it.
- Read `AGENTS.md` and the `AGENTS.md` of each package you change. They list the rules that tests enforce and the things that are easy to break.
- Do not commit secrets, real receipts or personal data. The evaluation data is synthetic, and the folders `packages/eval/results/` and `apps/desktop/release/` stay out of git.

## Repository settings (owner)

These settings live on GitHub, not in the repository, so no file can enforce them. Set them once, after the first push:

1. Settings, General, Features, Pull requests: choose "Collaborators only".
2. Settings, Rules, Rulesets: add a ruleset for the default branch that requires a pull request and a review from code owners, blocks force pushes and deletion, and requires the CI check to pass. Let the owner bypass it, because a sole owner cannot approve their own pull request.
