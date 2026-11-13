# Rill (agent guide)

Rill turns a plain-language request into a workflow and runs it on the user's own machine. [README.md](README.md) explains the product and [docs/security.md](docs/security.md) lists where each security control lives in the code. This file and the `AGENTS.md` of each package cover what a single source file does not show.

## Commands

Run everything from the repository root, with Node 24 and pnpm 11 (`.nvmrc` and `packageManager` in `package.json`).

- `pnpm check` runs lint, typecheck and every test. CI runs the same three steps (`.github/workflows/ci.yml`), so it must pass.
- `pnpm lint`, `pnpm typecheck` and `pnpm test` run those steps one at a time.
- `pnpm exec vitest run packages/engine` runs the tests of one package. Use `apps/desktop` for the app, or a test file path for one file.
- CI installs with `--frozen-lockfile`, so commit `pnpm-lock.yaml` together with a dependency change. `pnpm-workspace.yaml` lists which dependencies may run install scripts (`allowBuilds`).
- `pnpm eval` runs the evaluation harness. It calls model providers and spends real money, and it needs a provider key in the environment of the person's own terminal. `pnpm eval planner --dry` prints the estimate and calls no provider.
- Never run `pnpm eval` with `--yes`.
- Never start the desktop app (the `dev`, `storybook` and `smoke` scripts of `apps/desktop`) or any server unless the person asks. `pnpm demo:prepare` writes a folder in the home directory, so the same applies.
- Never ask for API keys and never look for them.

## Packages

| Path | Job | Guide |
| --- | --- | --- |
| `packages/dsl` | Workflow schema, graph and reference checks, issue codes | [AGENTS.md](packages/dsl/AGENTS.md) |
| `packages/protocol` | Message schemas and WebSocket client shared by the engine and the renderer | [AGENTS.md](packages/protocol/AGENTS.md) |
| `packages/llm` | One provider interface over Anthropic, OpenAI, Gemini, Grok and Meta, with prices | [AGENTS.md](packages/llm/AGENTS.md) |
| `packages/nodes-core` | The built-in nodes and the shared workflow validator | [AGENTS.md](packages/nodes-core/AGENTS.md) |
| `packages/planner` | Request to workflow: prompts, validation, repair, provenance flags, failure explanation | [AGENTS.md](packages/planner/AGENTS.md) |
| `packages/recipes` | Ready-made workflows and their parameter rules | [AGENTS.md](packages/recipes/AGENTS.md) |
| `packages/engine` | Durable executor, scheduler, SQLite store, WebSocket server, command line | [AGENTS.md](packages/engine/AGENTS.md) |
| `packages/eval` | Evaluation harness for extraction, planning and explanation | [AGENTS.md](packages/eval/AGENTS.md) |
| `apps/desktop` | Electron shell and React renderer, with Storybook | [AGENTS.md](apps/desktop/AGENTS.md) |

## Rules for every package

- Never write a key, a token or a connection secret into a log line, an error message, an event, a notice or the database. Run data that goes to a model has connection secrets masked first. Tests: `packages/llm/test/conformance.ts`, `packages/engine/test/explain-safety.test.ts`, `apps/desktop/test/main-ipc-handlers.test.ts`.
- Treat text from files, web answers, run records and model output as untrusted. The planner wraps attachments, notes and agent text in random tags and flags plan values that did not come from the user's words (`packages/planner/test/attachments/injection.test.ts`). The renderer bans markup injection (`apps/desktop/test/browser-safe.test.ts`) and marks invisible characters (`apps/desktop/src/ui/SafeText.tsx`).
- Disclose on screen what leaves the machine toward a model provider, before it is sent: `apps/desktop/src/chat/ExternalTransferNotice.tsx`, `apps/desktop/src/explain/ExplainNotice.tsx` and `apps/desktop/src/ui/TransferMark.tsx`. A change that adds data to a provider request needs the notice and `docs/security.md` updated. `apps/desktop/test/docs-claims.test.ts` pins sentences and table rows in `README.md`, `docs/demo.md` and `docs/security.md`, so update it together with the wording.
- Keep tests in the `test` folder of their package or app. The `include` patterns in `vitest.config.ts` and `apps/desktop/vitest.config.ts` skip a test file anywhere else, without a warning.
- Write strict TypeScript. `tsconfig.json` sets `strict`, `noUncheckedIndexedAccess` and `verbatimModuleSyntax`, so an indexed read can be `undefined` and a type-only import needs `import type`.
- Write no explanatory comments. Comment lines are rare in this code base, and `apps/desktop/test/app-source-rules.test.ts` fails on one under `apps/desktop/src/app`.
- Write an invisible or bidirectional character as a Unicode escape sequence (a backslash, the letter u and four hex digits). `apps/desktop/test/source-hidden-characters.test.ts` fails on a raw one in the protocol, engine, planner and `apps/desktop/src/app` sources.
- Keep user-facing text in Korean and English: the dictionaries in `apps/desktop/src/i18n` and the recipe texts in `packages/recipes/src/recipes`.
- Keep dependencies one way. `dsl` and `llm` depend on no workspace package, `protocol` on `dsl`, `nodes-core` on `dsl` and `llm`, `planner` and `recipes` on `nodes-core`, and `engine` and `eval` sit on top without importing each other. Packages export their source, so there is no build step between them.
- Do not edit a generated or golden file to turn a test green: `apps/desktop/src/fixtures/catalog.json`, `apps/desktop/src/fixtures/recipe-infos.json`, `packages/nodes-core/test/fixtures/validator-frozen.json`, `packages/planner/test/frozen` and `packages/eval/fixtures/extract`. The guide of each package says how its files are produced.

## Contributing

Pull requests are open to collaborators only and need the code owner's review (@minsu-kang). See CONTRIBUTING.md.
