# @rill/dsl (packages/dsl)

Owns the workflow format: the types and `WorkflowSchema`, the `{{id.output.path}}` reference syntax, the graph and reference checks, and the issue codes that every validation reports.

## Run

- `pnpm exec vitest run packages/dsl`

## Rules

- `SCHEMA_VERSION` is the literal in `WorkflowSchema` (`src/version.ts`, `src/schema.ts`). A workflow with another `schemaVersion` fails with `shape_const` (`packages/engine/test/deploy-parity.test.ts`).
- A node is a trigger exactly when its type starts with `trigger.` (`isTrigger` in `src/graph.ts`). The validator in nodes-core reports `kind_mismatch` when the registry disagrees, so name every trigger node `trigger.<name>@1`.
- Node types end in an at sign and a version number, as in `trigger.manual@1`, and node ids match `^[a-z][a-z0-9_]{0,31}$` (`src/schema.ts`).
- `referenceIssues` (`src/references.ts`) reports `unknown_ref_node`, `ref_not_upstream` and `malformed_template`. `unknown_output_field` comes from nodes-core, which knows each node's output schema, so an output field renamed there changes which references pass.
- Every code in `ISSUE_CODES` needs a row in `ISSUES.md` (`test/issues.test.ts`) and a message in the desktop app. `apps/desktop/test/recipes-drift.test.ts` fails on a code without one, and the table is `apps/desktop/src/recipes/model/problems.ts`.
- A code in `WARNING_CODES` never causes `deploy` to reject a workflow. List a new warning there as well as in `ISSUE_CODES`.
- Stages 1 to 3 are split. `shapeIssues`, `graphIssues` and `referenceIssues` live here, and the checks that need a node definition live in nodes-core. Keep node knowledge (config schemas, roles, side effects) out of this package.

## Do not

- Do not add a dependency on another workspace package. Everything above this package builds on it.
- Do not rename an issue code or change its pointer format. The desktop app maps each code to a message, and the planner repair loop sends codes and pointers back to the model.
