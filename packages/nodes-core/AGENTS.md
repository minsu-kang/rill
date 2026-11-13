# @rill/nodes-core (packages/nodes-core)

Owns the built-in nodes (4 triggers and 10 actions), the shared validator `validateWorkflow`, the rules policy, the path guard and the connection secret formats.

## Run

- `pnpm exec vitest run packages/nodes-core`

## Rules

- One definition per node (`defineAction` and `defineTrigger` in `src/types.ts`) feeds the planner catalog, the validator and the executor. Register it in `createCoreRegistry` (`src/core.ts`).
- The catalog has 14 node types. Adding or removing one means updating `CATALOG_TYPES` in `packages/eval/src/suites/planner/assertions.ts`, the counts in `packages/eval/test/planner-assertions.test.ts` and `packages/eval/test/planner-suite.test.ts`, and the check in `packages/eval/src/suites/planner/consistency.ts`.
- A change to a node's title, description or schemas changes the planner snapshot `packages/planner/test/__snapshots__/catalog.test.ts.snap` and the desktop fixture `apps/desktop/src/fixtures/catalog.json` (see `apps/desktop/AGENTS.md`).
- A dry run (`dryRun` in the node context) of a node with a side effect returns a placeholder before any file write, network call or connection lookup (`test/google-sheets-append.test.ts`, `test/http-request-hosts.test.ts`). `csv.append` still checks its path first. `file.read` and `llm.extract` ignore `dryRun`, because reading is not a side effect.
- Every config string that names a path, URL, connection or recipient declares a role in `roles`, or `test/roles.test.ts` fails. The planner flags values by role.
- A node reads a connection secret only through the connection resolver in its context. A node with a connection role also needs an entry in `CONNECTION_KINDS` (`packages/planner/src/connections.ts`, checked by `packages/planner/test/connections.test.ts`).
- Hosts are fixed in code: Slack posts to `SLACK_POST_URL` (`src/slack-post.ts`) and the spreadsheet nodes use an `ORIGIN` constant each. Only `http.request` takes a URL from the workflow, and it asks the `hostAllowed` check before the request.
- File paths go through `assertPathAllowed` (`src/guard.ts`), which resolves real paths, at validation and again at run time.
- A node never puts a connection secret into its output or its errors. `http.request` masks them in both (`test/http-request.test.ts`).
- With no rule set, `validateWorkflow` returns exactly the issues it returned before rules existed (`test/validate-rules.test.ts` against `test/fixtures/validator-frozen.json`). Planning and deploy validate alike (`packages/engine/test/deploy-parity.test.ts`).

## Do not

- Do not regenerate `test/fixtures/validator-frozen.json` to turn a test green.
- Do not log a connection secret or read one from anywhere but the connection resolver.
- Do not add a node that takes a user-chosen host without a `url` role and a host check.
