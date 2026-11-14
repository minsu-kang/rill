# Security policy

Rill is in early development and has no release yet, so only the latest commit on `main` is supported. One maintainer handles reports, on a best-effort basis.

## Report a vulnerability

Use GitHub's private vulnerability reporting: open the Security tab of this repository, choose "Report a vulnerability" and describe the problem. Do not open a public issue or a pull request for a vulnerability.

A useful report has the commit or version, the steps to reproduce, and what an attacker gains. Do not send real API keys, tokens or personal data. Use synthetic values.

## What is in scope

- The desktop app (`apps/desktop`), the engine and the packages in this repository.
- The folder allow-list, the handling of secrets, the checks on text from files, web answers and model output, and the data that leaves the machine toward a model provider.

[docs/security.md](docs/security.md) lists where each control lives in the code and what is not covered, for example software that runs as the same user. A report about something listed there as not covered is a feature request, not a vulnerability.

## What is out of scope

- A vulnerability in a dependency. Report it to that project. If Rill uses it in a way that makes it exploitable, report that here.
- A model that follows an instruction hidden in a document. The planner flags values that did not come from your words, and a person confirms them before anything runs. A case where a flag is missing is in scope.
