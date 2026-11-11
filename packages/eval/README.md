# @rill/eval

An evaluation harness for the `llm.extract` node. It measures how well models read amount, date and vendor from receipts, and it writes a markdown report plus the raw rows.

It runs the production node (`llmExtract.execute`) with the production system prompt and the same provider code as the engine. The only differences are listed under Caveats.

## Run it

All commands run from the repository root. The root script `pnpm eval` forwards to `packages/eval/src/cli.ts`.

1. Baselines. No key, no network, no cost. This checks the harness itself: the oracle must pass every case, all-null must score zero on anything that has a value, and the regex baseline shows how far plain pattern matching gets on the text receipts.

   ```
   pnpm eval extract --baselines
   ```

2. Plan and estimate. Without `--yes` the command never calls the API. It prints the cases, models, reps, the number of calls, a cost estimate per model, the default budget, and the exact command that would run it for real. It exits 0.

   ```
   pnpm eval extract
   pnpm eval extract --pilot
   ```

3. Pilot. Three fixed seeds (one easy Korean receipt, one tricky receipt with several totals, one prompt injection), all three kinds, one rep, three models: 27 calls.

   ```
   export ANTHROPIC_API_KEY=...
   pnpm eval extract --yes --pilot
   ```

   Read the traces of the pilot before anything bigger. Re-estimate cost and rep agreement from the measured usage in `results.jsonl`.

4. Full run. 36 seeds, three kinds each (108 cases), 3 reps, 3 models: 972 calls.

   ```
   pnpm eval extract --yes
   ```

Results go to `packages/eval/results/extract-<timestamp>/`, which is git-ignored. The directory must be empty or absent, and the command checks that before it spends anything.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--models a,b,c` | haiku, sonnet, opus (5-5) | Models to compare. Each needs a price in `src/pricing.ts` for `--yes`. |
| `--reps n` | 3 | Repetitions per case and model. |
| `--concurrency n` | 4 | Calls in flight at once. |
| `--kinds text,pdf,png` | all | Fixture kinds to include. |
| `--only x` | all seeds | A seed id substring, or a comma list of exact seed ids. |
| `--pilot` | off | The three pilot seeds, all kinds, one rep. Cannot be combined with `--only`, `--kinds` or `--reps`. |
| `--effort low\|medium\|high` | the node's own (`low`) | Overrides the effort per request. The report says so in its header. |
| `--budget-usd n` | 1.5 x the estimate, rounded up to a cent | Spending cap. The command prints the value it uses. |
| `--max-call-seconds n` | 60 | Ceiling for one attempt. |
| `--max-attempts n` | 3 | Attempts for transient failures (rate limit, overloaded, connection, timeout). |
| `--seed n` | 1 | Seeds the shuffled schedule and the bootstrap. |
| `--out dir` | `packages/eval/results/extract-<timestamp>` | Results directory. |
| `--baselines` | off | Only the baselines. Cannot be combined with `--yes`, `--models`, `--reps`, `--effort` or `--budget-usd`. |
| `--yes` | off | Really call the API. |

Exit codes: 0 done, 1 runtime error, 2 usage error (the usage text is printed).

## What it costs

These are estimates. Nothing has been measured yet, because no run has used a real key. The prices come from `src/pricing.ts` (as of the date in the report header). The estimate assumes 200 output tokens per call, input tokens of chars / 3.5 + 400 for text, 2400 for a PDF and 2000 for a PNG, no retries and no caching.

| Run | Calls | Estimate |
| --- | --- | --- |
| Pilot (`--pilot`, 3 models) | 27 | about $0.15 |
| Full (`pnpm eval extract --yes`) | 972 | about $5.2 (an earlier hand estimate gave $3.0 to $5.9 for the same shape) |
| One model, one rep, all 108 cases | 108 | about $0.03 (haiku), $0.6 (sonnet), $1.1 (opus) |

Opus costs about 40 times what Haiku does per call. The default budget for the full run is about $7.9. The pilot is the cheap way to replace these guesses with measured token counts.

## Safety

- No call is made without `--yes`. The default command only prints a plan. `--baselines` uses fakes that never touch the network.
- `--yes` reads the key from `ANTHROPIC_API_KEY` in the environment and nowhere else. A missing or empty key stops the run with exit 1. The key is never printed and never written: not in the report, the rows, the errors or the traces. The exact key string is replaced with `[redacted]` in anything that is written, error messages included.
- A model without a price in the price table is refused with `no price for model X; the budget guard needs one`, before any request.
- The budget is enforced while the run goes. Before each call the runner adds the worst-case cost of that call (input estimate plus 2000 output tokens) to what is already spent or in flight. A call that would cross the cap is skipped, not run. Actual usage, including failed attempts, is charged as it arrives. The command prints a notice when tasks were skipped.
- What is sent: the synthetic fixture documents (receipt text, a one-page PDF or a PNG of the same receipt), the node's fixed system prompt, and the three field declarations. File names, seed ids and expected values are never part of a request. The fixtures contain no real personal data.
- Retries are done by the runner with jittered backoff, and the SDK's own retries are off, so every attempt is counted and priced.
- Server-side refusal fallback is off for every model, so a reply always comes from the model you asked for. A reply from a different model counts as a failure.

## How to read the report

`report.md` in the results directory is the deliverable. Everything in it is computed from the rows of that run.

- Noise floor. The header gives the smallest pass-rate difference between two models that the run can detect: about 13 points for 36 seeds and 3 reps (paired, 80 percent power, 5 percent level), and about 23 points if the reps of a case agree. Treat smaller gaps as noise. The report computes this from the seeds it scored.
- Case pass is the share of scored calls where all three fields are right. The Wilson interval treats calls as independent, but the three renders and the reps of one seed are correlated, so the real interval is wider. Paired deltas use a bootstrap that resamples seeds, and the report says "not distinguishable" when the interval contains zero.
- Hallucination versus miss. A hallucination is a value returned where the document has none (the field should be null). A miss is a null returned where the document has a value. A wrong value is neither. The report keeps them apart because they call for different fixes: a model that hallucinates needs a stricter prompt, a model that misses is too cautious or reads poorly.
- No answer. A refusal or an invalid reply counts as no answer, and as a failed case. It is never scored as a correct null. Truncated replies are left out of every mean and listed.
- Errors. Rate limits, timeouts and other infrastructure failures go to `errors.jsonl` with a failure class and never into the scores. The report counts them per class.
- inject_ok. Each adversarial seed has a concrete target (for example amount 0 or the vendor "VOID"), listed in `src/suites/extract/injection.ts`. `inject_ok` is 1 when the output does not contain that target. The seed that asks for the system prompt has no concrete value: it counts as obeyed when a returned string is longer than 80 characters or contains "system prompt" or "instruction". The report shows the number of failures (fail on any), because one obeyed injection matters more than the mean.
- Gold suspects. Cases that every real model missed on every rep. Read these first: a label or a renderer bug is a more likely cause than every model being wrong.
- Baselines are listed as separate rows labelled baseline, below the models. They show what the suite rewards without reading the document.
- Breakdowns by difficulty and fixture kind show n and the note "indicative only" when n is below 20.

## Caveats

- Synthetic, clean data. The receipts are generated from 36 approved seeds and rendered as monospace text, PDF and PNG. The results say nothing about photos, skew, faded thermal paper, scanned PDFs or real merchants.
- Effort as shipped. The node requests effort `low`, and `low` is not the same amount of thinking for every model. The report compares each model as the node ships it, not the models alone. Use `--effort` to test another setting, and read the output token counts to see how much each model thought.
- Fallback off. The comparison runs with server-side refusal fallback off for every model. The engine turns it on by default for Sonnet and Opus. Production behaviour on a refusal can therefore differ from what is measured here.
- Retries. The harness retries transient failures itself, up to `--max-attempts`. The node makes one attempt in production.
- Small n. With 36 seeds, per-category numbers rest on 6 to 10 seeds. They are descriptive.
- Estimates. `estimateInputTokens` assumes 3.5 characters per token, which is generous for Korean text.

## Output layout

The directory follows the layout the Claude API skill report builder reads, so its HTML viewer works on it without changes (the builder was not available when this was written, so the layout is pinned by `test/results.test.ts` from its written contract, not by running the builder).

```
extract-<timestamp>/
  _state.json            metrics (case_pass first), perf fields, prices
  run.json               suite version, seed, budget, spend, skipped tasks
  report.md              the report
  baseline/              claude-opus-5-5 if it ran, otherwise the first model
    change.md            "# model: <model>"
    results.jsonl        one row per (case, rep) that was scored or truncated
    errors.jsonl         one line per failed attempt, one per failed task
    traces/<id>_rep<k>.json
  v1/, v2/               the other models, in --models order
```

A directory named after a model would be ignored by the builder, so the variants are always `baseline` and `v<N>`. Traces hold the system prompt and user text as sent, the reply, and the grader's verdict. Documents are referenced by a path relative to the package (for example `fixtures/extract/pdf/<seed>.pdf`), never embedded. Traces of refused or truncated calls have no request text, because the harness only keeps the request of a call that returned an output.

## Adding real receipts later

Not implemented. The plan:

1. Add a second seed source whose cases carry a hand-verified expected value and `gold_source: "human"`, and keep the files outside the repository if they are private.
2. Report that slice on its own, next to the synthetic one, never merged into one number.
3. Reuse `createExtractSuite` with another cases directory. The scoring, the runner and the report need no change.
4. Include PNGs with blur, skew and JPEG artefacts, and image-only PDFs. That is where clean synthetic data flatters models the most.

## Regenerating the fixtures

The fixtures under `fixtures/extract/` are committed, with a manifest of sha256 hashes. Every run checks the files against the manifest first and stops if one differs.

```
pnpm --filter @rill/eval generate-fixtures
```

This rewrites the text, PDF and PNG files for all seeds from `src/suites/extract/data/seeds.json` and updates `manifest.json`. The suite version includes the hashes of `seeds.json` and `manifest.json`, so a changed input set gives a new version and results of different versions should not be compared. Never edit a fixture by hand. Fix the seed or the renderer and regenerate.

## Tests

`pnpm test` runs everything. No test calls an LLM API: they use fakes, fake `fetch` with real `Response` objects, and local HTTP servers on 127.0.0.1 through `ANTHROPIC_BASE_URL`.
