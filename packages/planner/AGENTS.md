# @rill/planner (packages/planner)

Owns turning a request into a workflow, questions or a refusal: prompts, constrained generation, validation and repair, provenance flags, the failure explanation and the plan review.

## Run

- `pnpm exec vitest run packages/planner`

## Rules

- The planner reaches a model only through `LlmProvider` and reads attachments only through the `AttachmentStore` port (`src/ports.ts`). It has no file system, network or database access, so a model answer cannot create a rule, a note, an agent or a hook.
- Prompt text is pinned by golden files. Without an agent or skills, the system blocks and messages stay byte-identical to `test/frozen/requests.json` (`test/frozen-requests.test.ts`). Skills and reviews have their own goldens (`test/frozen-skills-requests.test.ts`, `test/frozen-review-requests.test.ts`). The node catalog text is pinned by `test/__snapshots__/catalog.test.ts.snap`.
- A plan value that did not come from the user's words (an attachment, a new send or write target, a path built from document content) gets a flag and sets `needsConfirmation` (`src/attachments/provenance.ts`). The engine refuses to deploy until every flag is confirmed (`packages/engine/test/engine-plan.test.ts` for `deployPlan`, `packages/engine/test/deploy-gate.test.ts` for `deploy`).
- A model answer is checked against the generation schema and `validateWorkflow`, then repaired for up to 3 rounds (`DEFAULT_MAX_REPAIR_ROUNDS` in `src/plan.ts`). A repair message never repeats a value taken from an attachment (`test/attachments/injection.test.ts`).
- Attachments, notes and agent text are wrapped in random tags before a model sees them (`src/attachments/prepare.ts`, `src/memory.ts`, `src/agent.ts`).
- The provider receives the planner instructions, the node catalog, the allowed folders, connection names and kinds (never secrets), the request and earlier turns, attachments, saved notes, the chosen agent and its skills, and the rules the user set. Anything new in a request needs the on-screen notice and `docs/security.md` updated.
- `HIDDEN_FIELDS` (`src/hidden.ts`) are advanced settings. The catalog hides them, and a plan that sets one gets the issue `planner_hidden_field`.
- The explanation replaces connection secrets with `<secret>` in several encodings (`src/explain/excerpt.ts`, `test/explain/redaction.test.ts`) and replaces new URLs, hosts and addresses in the answer with `<hidden>` (`src/explain/scrub.ts`, `test/explain/scrub.test.ts`).
- The generation schema must pass the strict-schema limits of OpenAI and Gemini (`test/openai-schemas.test.ts`, `test/gemini-schema.test.ts`).

## Do not

- Do not edit a golden file or the catalog snapshot to turn a test green. A diff means a request changed: decide that on purpose and say so in the pull request.
- Do not build a prompt from run data without the masking in `src/explain/excerpt.ts`.
- Do not import `node:fs`, a database or a network client.
