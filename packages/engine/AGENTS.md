# @rill/engine (packages/engine)

Owns durable workflow execution: the executor, scheduler and triggers, the SQLite store, the WebSocket server and the `rill-engine` command line. [README.md](README.md) documents every method and error code.

## Run

- `pnpm exec vitest run packages/engine`. Several tests start child processes, for example `test/kill-recovery.test.ts` and `test/cli-connections-env.test.ts`.

## Rules

- The desktop app runs the engine as a child process from one bundled file built by `apps/desktop/scripts/bundle-engine.ts`. `apps/desktop/test/main-engine-bundle.test.ts` bundles it and starts it with plain Node, so a dependency that esbuild cannot bundle breaks that test.
- The server listens on 127.0.0.1 only. It accepts a client only with the token in the `rill.token.<token>` subprotocol, a local Host header and, when an Origin header is sent, an allowed Origin (`src/server/server.ts`, `test/server.test.ts`).
- Secrets arrive through the process environment: `RILL_TOKEN`, `RILL_CONNECTIONS` and the provider key variable. The command line removes the token from the environment and reads the connections once (`src/cli.ts`, `test/cli-connections-env.test.ts`). They never go to the database, an event, a log line or an error.
- `src/migrations.ts` holds numbered migrations: the version is the array index plus one, and `migrate` runs the missing ones in a transaction. Only append. A new migration changes the hard-coded list of versions 1 to 9 in `test/migrations.test.ts`, `test/db.test.ts`, `test/agents.test.ts`, `test/hooks-migration.test.ts`, `test/memory.test.ts`, `test/rules-migration.test.ts` and `test/store-triggers.test.ts`.
- The store uses `node:sqlite` in WAL mode (`src/db.ts`). A step attempt is written before it runs, so a run killed with SIGKILL resumes (`test/kill-recovery.test.ts`).
- Delivery is at least once. A step has the idempotency key `runId:nodeId`. Only `csv.append` records `intent` and `done` in the journal and deduplicates, so a crash or a retry after a server error can repeat a Slack message, a spreadsheet row or an HTTP call.
- Rules and hooks are enforced here, not in the window. Deploy, plan deploy, recipe instantiation, activation, run start, trigger firing and `http.request` all check rules (`src/rules.ts`, `test/rules-enforcement.test.ts`). A hook cannot start a run, a plan or a model call (`src/hooks-runner.ts`, `test/hooks-runner.test.ts`).
- `deploy` and `validateWorkflow` agree on every workflow (`test/deploy-parity.test.ts`). `deployPlan` refuses a plan with an unconfirmed flag (`test/engine-plan.test.ts`), and `deploy` refuses the content of a flagged plan that is still open (`test/deploy-gate.test.ts`).
- A method that handles user text belongs in `NAME_ONLY_ERROR_METHODS` (`src/server/server.ts`), so an unexpected failure logs only the error name.

## Do not

- Do not edit or reorder an existing migration. Databases that already ran it would differ.
- Do not call `console` outside `src/cli.ts`.
- Do not start `serve` by hand to check a change. The tests start their own servers (`test/cli-serve.test.ts`).
- Do not let a model answer, an attachment, a recipe or a run create or change a rule, a note, an agent or a hook. Only their save methods write them, and only the migrations and the store mention their tables (`test/agents-sources.test.ts`, `test/hooks-sources.test.ts`, `test/skills-sources.test.ts`, `test/review-sources.test.ts`).
