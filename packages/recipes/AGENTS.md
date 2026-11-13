# @rill/recipes (packages/recipes)

Owns the ready-made workflows (eight recipes), the form parameters that fill them and the parameter rules. It needs no model, key or network. [README.md](README.md) has the format, the parameter kinds and the catalogue.

## Run

- `pnpm exec vitest run packages/recipes`

## Rules

- A form value replaces a whole `$param` placeholder inside the `config` of a node. There is no interpolation, and a text value that contains `{{` or `}}` is refused, so a form value can never become a run-time reference (rule `template_text` in `src/params.ts`, `test/params.test.ts`).
- A problem is `{ param, rule }` and never holds the value. The rule names in `PARAM_RULES` and `GENERAL_RULES` are mirrored by the desktop form: `apps/desktop/test/recipes-drift.test.ts` fails when `apps/desktop/src/recipes/model/problems.ts` lacks one.
- Every title, description, label and help comes in Korean and English. `test/recipes.test.ts` requires Hangul in each `ko` text and none in any `en` text.
- Every recipe id is listed in several places: `RECIPES` (`src/recipes/index.ts`), `EXPECTED_IDS` in `test/recipes.test.ts`, the list in `packages/engine/test/recipes-dry-run.test.ts` and the tables in `packages/engine/test/server-recipes.test.ts`, which also counts 8. Adding or removing a recipe means updating all of them, then regenerating `apps/desktop/src/fixtures/recipe-infos.json` (see `apps/desktop/AGENTS.md`).
- The sample values of a recipe must instantiate into a workflow with no issue and no warning from `validateWorkflow` (allowed folder /Users/demo, connections named `slack-ops`, `google` and `microsoft`). Samples use only demo folders under /Users/demo and the host example.test, and the tests refuse a token, a personal path or a real host.
- A recipe uses only node types of the core registry. This package does not know the allowed folders or the configured connections, and it never touches the file system. The engine validates the finished workflow with both.
- The CSV file of the two recipes that append to one (`receipt-folder-to-csv` and `receipt-big-amount-alert`) must stay outside the watched folder. `validateWorkflow` refuses the other layout as `inside_watched_folder`, because every new row would start the workflow again.

## Do not

- Do not build a workflow by replacing text in a string or in JSON text.
- Do not add a parameter kind without its rules in `PARAM_RULES`. The tests prove that every listed rule is reachable.
- Do not carry credentials in a recipe or a value. A connection is named, and a `url` value with a user name or password is refused (`url_credentials`).
