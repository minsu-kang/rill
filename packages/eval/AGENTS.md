# @rill/eval (packages/eval)

Owns the evaluation harness: the extraction suite for `llm.extract`, the planner suite, the explanation suite, the budget guard and the `check-provider` command. [README.md](README.md) has the options and the results.

## Run

- `pnpm exec vitest run packages/eval` runs the offline tests. None of them calls a model.
- `pnpm eval planner --dry` prints the cases, the estimated cost and the command that would run them. It sends nothing, and it is also what the command does without `--yes`.
- `pnpm eval extract --baselines` scores the baselines with no key, no network and no cost. It writes a results folder.
- `pnpm eval check-provider --provider anthropic --model claude-sonnet-5-5 --dry` prints the plan of the live checks and sends nothing.

## Rules

- A run that spends money needs `--yes`, and `--yes` needs `--budget-usd` for the extract and planner suites (`check-provider` defaults to 0.25). The guard stops before a call whose worst case does not fit.
- Provider keys come only from the environment (`src/cli-providers.ts`), and error text redacts every key it holds. Nothing accepts a key as an option or reads one from a file.
- Run output goes to a results folder under `packages/eval`, which `.gitignore` excludes. Do not commit it. The output folder must be empty or absent before a run.
- The cases are approved by the repository owner: `src/suites/planner/data/cases.json`, `src/suites/explain/data/cases.json` and the seeds in `src/suites/extract/data/seeds.json`. `checkConsistency` pins the planner case count (61) and the expectations (`test/planner-consistency.test.ts`).
- The extraction fixtures are generated from the seeds. Inside `packages/eval`, `pnpm generate-fixtures` rewrites them and `fixtures/extract/manifest.json`, which every run checks first. `pnpm generate-planner-attachments` does the same for the planner attachments.
- The suite version includes the data hashes, `SCORER_VERSION` and `INJECTION_VERSION`. Bump those constants by hand when the rules change, and do not compare results of different versions.
- `CATALOG_TYPES` in `src/suites/planner/assertions.ts` must equal the node registry (`checkConsistency`).
- The explanation suite has no command line. It runs through `createExplainSuite` and `runEval`.

## Do not

- Do not run any command here with `--yes`. It spends money on the person's key.
- Do not add, remove or edit a case or a seed without the owner's approval.
- Do not edit a fixture by hand. Fix the seed or the renderer and regenerate.
- Do not tune prompts or field wording against the known extraction cases. A fix found that way fits the test set.
