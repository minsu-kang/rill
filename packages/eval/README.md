# @rill/eval

An evaluation harness for the `llm.extract` node. It measures how well models read amount, date and vendor from receipts, and it writes a markdown report plus the raw rows.

It runs the production node (`llmExtract.execute`) with the production system prompt and the same provider code as the engine. The only differences are listed under Caveats.

## Run it

All commands run from the repository root. The root script `pnpm eval` forwards to `packages/eval/src/cli.ts`.

1. Baselines. No key, no network, no cost. This checks the harness itself: the oracle must pass every case, all-null must score zero on anything that has a value, and the regex baseline shows how far plain pattern matching gets on the text receipts.

   ```
   pnpm eval extract --baselines
   ```

2. Plan and estimate. Without `--yes` the command never calls the API. It prints the cases, models, reps, the number of calls, a cost estimate per model, a suggested budget, the break-even average output per call at that budget, the worst case of one call, and the exact command that would run it for real. It exits 0.

   ```
   pnpm eval extract
   pnpm eval extract --pilot
   ```

3. Pilot. Three fixed seeds (one easy Korean receipt, one tricky receipt with several totals, one prompt injection), all three kinds, one rep, three models: 27 calls.

   ```
   export ANTHROPIC_API_KEY=...
   pnpm eval extract --yes --pilot --max-output-tokens 4000 --budget-usd 0.51
   ```

   The pilot defaults to `--max-output-tokens 4000` (replies that hit it are recorded as truncated), so the worst case of one Opus call is about $0.09 and four calls in flight reserve about $0.36. With the node's own 16000 the worst case of one Opus call would be about $0.33, so a pilot would need a budget of at least about $1.50. The suggested budget is the larger of 2 x the estimate and the estimate plus the reserve for the calls in flight, so the printed command always runs.

   Read the pilot before anything bigger, then replace the assumptions of the estimate with what it measured. See "After the pilot".

4. Full run. 36 seeds, three kinds each (108 cases), 3 reps, 3 models: 972 calls.

   ```
   pnpm eval extract --yes --budget-usd 10.49
   ```

   `--budget-usd` is required with `--yes`. Take the suggested value from the plan, or better, from `--reestimate` on the pilot (see "After the pilot"), which prices the output tokens the pilot measured.

Results go to `packages/eval/results/extract-<timestamp>/`, which is git-ignored. The directory must be empty or absent, and the command checks that before it spends anything. While the run goes, every finished task is appended to `tasks.partial.jsonl` in that directory (compact lines: case, model, rep, status, outcomes, output values, usage and cost; no documents and no key), so a crash keeps what was paid for. The final write replaces it with the files below and removes it.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--models a,b,c` | haiku, sonnet, opus (5-5) | Models to compare. Each needs a price in `src/pricing.ts` for `--yes`. |
| `--reps n` | 3 | Repetitions per case and model. |
| `--concurrency n` | 4 | Calls in flight at once. |
| `--kinds text,pdf,png` | all | Fixture kinds to include. |
| `--only x` | all seeds | A seed id substring, or a comma list of exact seed ids. |
| `--pilot` | off | The three pilot seeds, all kinds, one rep, with `--max-output-tokens` defaulting to 4000. Cannot be combined with `--only`, `--kinds` or `--reps`. |
| `--effort low\|medium\|high` | the node's own (`low`) | Overrides the effort per request. The report says so in its header. |
| `--budget-usd n` | none, required with `--yes` | Spending cap in dollars. The plan prints a suggested value: the larger of 2 x the estimate and the estimate plus the guard's reserve for the calls in flight, rounded up to the next cent (with more digits below a cent). |
| `--max-output-tokens n` | 16000 (what the node ships) | `max_tokens` of every request, 1 to 64000, and the output side of the budget guard's worst case per call. Thinking tokens count against it. |
| `--max-call-seconds n` | 60 | Ceiling for one attempt, 1 to 600. The SDK timeout is set just above it. |
| `--max-attempts n` | 3 | Attempts for transient failures (rate limit, overloaded, connection, timeout, bad response), 1 to 10. |
| `--reps n`, `--concurrency n` | 3, 4 | Limits: reps 1 to 20, concurrency 1 to 16. |
| `--seed n` | 1 | Seeds the shuffled schedule and the bootstrap, 0 to 4294967295. |
| `--out dir` | `packages/eval/results/extract-<timestamp>` | Results directory. |
| `--allow-base-url` | off | Allow an `ANTHROPIC_BASE_URL` other than `https://api.anthropic.com`, or a set `ANTHROPIC_CUSTOM_HEADERS`. The key is sent to that host. |
| `--reestimate dir` | off | Re-estimate the full run from the results directory of a pilot. Takes only `--models`, `--reps`, `--kinds`, `--only`, `--max-output-tokens` and `--concurrency`; any other option is a usage error. No key, no network, nothing written. See "After the pilot". |
| `--baselines` | off | Only the baselines. Cannot be combined with `--yes`, `--models`, `--reps`, `--effort`, `--budget-usd`, `--max-output-tokens` or `--allow-base-url`. |
| `--yes` | off | Really call the API. Needs `--budget-usd`. |

The printed command repeats every option that differs from its default (`--only`, `--kinds`, `--effort`, `--seed`, `--max-output-tokens` and so on), so it reproduces the plan exactly.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Done, every task ran. |
| 1 | Runtime error, a refused base URL or header, or a run stopped at the first authentication failure. |
| 2 | Usage error (the usage text is printed), including `--yes` without `--budget-usd`. |
| 3 | Partial run: the budget ran out. The report starts with a PARTIAL RUN notice. |
| 130 | Interrupted by SIGINT or SIGTERM. The results and the report are written as a partial run. |

## After the pilot

The pilot measures what the estimate only assumed: 200 output tokens per call, 3.5 characters per token for text, 2400 input tokens for a PDF and 2000 for a PNG. Go through it in this order.

1. Read the pilot report (`report.md` in the results directory, printed as `report:` at the end of the run). Check five things.
   - Output tokens per call: the "Mean output tokens" column of the latency, tokens and cost table. Thinking is billed as output, so this is usually well above the 200 the estimate assumed, and it moves the cost more than anything else.
   - Truncated rows: the "Truncated rows" section. A reply that reached `--max-output-tokens` was cut off. The pilot caps replies at 4000 tokens, so a truncated row is a call that wanted more. The report leaves truncated rows out of its means; `--reestimate` counts them, because they are billed.
   - Refusals and invalid replies: the "Errors" section and the No answer column. They count as no answer, never as a correct null.
   - Errors: rate limits, timeouts and connection drops, also listed in `errors.jsonl` of each model folder. They are retried and billed, and they stay out of the means. Many of them suggest a lower `--concurrency` for the full run.
   - Rep agreement: the "Rep agreement" section. It shows n/a for a pilot, which has one rep. To see it before the full run, repeat the three pilot seeds with `--reps 2`, which costs about twice the pilot.

2. Re-estimate the full run from the measured usage. The command never calls the API, needs no key and writes nothing into the results directory.

   ```
   pnpm eval extract --reestimate packages/eval/results/extract-<timestamp>
   ```

   Use the directory the pilot printed as `results:`. A relative path is resolved from the directory where you started pnpm. The plan flags are the ones of the plan mode (`--models`, `--reps`, `--kinds`, `--only`, `--max-output-tokens`, `--concurrency`) and default to the full run, so change them only to price another plan. A pilot that crashed before its final write still has `tasks.partial.jsonl`; the command reads that when there is no `run.json`.

   It prints, for each model and kind: the calls of the plan, the pilot calls behind the numbers (n), the mean and the 90th percentile of the input and output tokens, the measured cost per call, and the projected cost at the mean and at the 90th percentile. The 90th percentile column prices the p90 input tokens and the p90 output tokens together, so it is a pessimistic bound, not a forecast. Below each table it shows the output tokens per call the pilot saw against the 200 assumed, and how many pilot calls were truncated or refused.

   Then it prints the totals, the SUGGESTED BUDGET, the break-even output tokens per call at that budget, the warnings and the exact command for the full run. The budget is the larger of 1.3 x the p90 total and the mean total plus the guard's reserve for the calls in flight, rounded up to the cent.

   Read the warnings. The pilot saw only three calls per model and kind from three seeds that were not drawn at random, so the projection is rough. A kind with fewer than two pilot calls uses the pilot mean of that model across kinds, and a model with no pilot row falls back to the original assumption; the table marks both FALLBACK. Truncated pilot rows make the projection a minimum when the full run allows more output tokens than the pilot did; the command then prints the total at the mean if every such call used the whole cap, and says when the suggested budget is below it. If the default `--max-output-tokens 16000` makes the guard's reserve a large share of the cost, the command also prints the budget at a lower cap (2000, 4000 or 8000, the smallest that leaves twice the largest pilot reply) and its command. The consequence of a lower cap is that a call needing more output tokens is cut off and recorded as truncated, which counts as no answer.

   The command repeats the effort the pilot ran with, because token counts measured at one effort do not carry over to another. It warns when the pilot ran another suite version than this checkout.

3. Run the command it printed. That is the full run.

## What it costs

These are estimates. Nothing has been measured yet, because no run has used a real key. The prices come from `src/pricing.ts` (as of the date in the report header). The estimate assumes 200 output tokens per call, input tokens of chars / 3.5 + 400 for text, 2400 for a PDF and 2000 for a PNG, no retries and no caching. These models think before they answer, and thinking tokens are billed as output tokens, so 200 is likely low; the plan prints the break-even average output per call at the chosen budget so you can see how much room there is. After the pilot, `--reestimate` replaces these assumptions with measured token counts.

| Run | Calls | Estimate |
| --- | --- | --- |
| Pilot (`--pilot`, 3 models) | 27 | about $0.15 |
| Full (`pnpm eval extract --yes`) | 972 | about $5.2 (an earlier hand estimate gave $3.0 to $5.9 for the same shape) |
| One model, one rep, all 108 cases | 108 | about $0.03 (haiku), $0.6 (sonnet), $1.1 (opus) |

Opus costs about 40 times what Haiku does per call. The suggested budget for the full run is $10.49 (2 x $5.24); at that budget the run breaks even at about 600 output tokens per call on average. The pilot is the cheap way to replace these guesses with measured token counts.

## Safety

- No call is made without `--yes`. The default command only prints a plan. `--baselines` uses fakes that never touch the network.
- `--yes` reads the key from `ANTHROPIC_API_KEY` in the environment and nowhere else, and passes it to the SDK explicitly, so the SDK never falls back to another credential. The key is trimmed; a missing, empty or whitespace-only key stops the run with exit 1. The key is never printed and never written: not in the report, the rows, the errors or the traces. The exact key string is replaced with `[redacted]` in anything that is written, error messages included. The library API (`runEval`) never builds a paid provider on its own: the caller must pass `createProvider`, and `createEvalProvider` needs an explicit key.
- Before any request the command prints the API host. If `ANTHROPIC_BASE_URL` points anywhere but `https://api.anthropic.com`, or `ANTHROPIC_CUSTOM_HEADERS` is set, it refuses to run (exit 1) unless `--allow-base-url` is given, and then prints a loud warning that the key goes to that host. The notice about the documents names the same host.
- A model without a price in the price table is refused with `no price for model X; the budget guard needs one`, before any request.
- The budget is a hard cap. Before each call the runner reserves the worst case of that call: its input estimate plus `--max-output-tokens` output tokens at the model's price, the same `max_tokens` the request really carries (a request that asks for more stops the run). It adds that to what is spent and what is held for calls in flight. At the first call that would cross the cap, it stops dispatching: every remaining task is recorded as skipped (`budget_skipped` in `errors.jsonl`), `run.json` says `partial: true`, the report starts with a PARTIAL RUN notice with completed and skipped tasks per model, and the command exits 3. Because the schedule is shuffled across models, the finished tasks are a prefix of it and the models stay comparable. A retry is only sent while it still fits.
- Charging: actual usage is charged as it arrives. An attempt stopped at the time ceiling, aborted by a second interrupt, or whose reply body broke off is charged its full worst case, because the API may bill it. An attempt that was sent but got no HTTP answer, or got a reply that is not a Messages API object, is charged its input estimate. A reply whose usage is not a finite, non-negative count below 1e9 is never charged from those numbers; it counts as a bad response.
- The first authentication failure stops the run: no further requests, the remaining tasks are skipped, the report is partial and the command exits 1.
- Interrupts: the first SIGINT or SIGTERM stops new calls and lets the calls in flight finish within `--max-call-seconds`; a second one aborts them. The results and the report are then written as a partial run and the command exits 130.
- What is sent: the synthetic fixture documents (receipt text, a PDF of one or two pages (the long receipt `tricky-ko-long-mart` has two) or a PNG of the same receipt), the node's fixed system prompt, and the three field declarations. File names, seed ids and expected values are never part of a request. The fixtures contain no real personal data.
- Retries are done by the runner with jittered backoff, and the SDK's own retries are off, so every attempt is counted and priced.
- Server-side refusal fallback is off for every model, so a reply always comes from the model you asked for. A reply counts as from that model only when its `model` is exactly the requested id or the requested id followed by a dash and an eight-digit date (a dated snapshot); anything else is a `served_model_mismatch` failure.

## How to read the report

`report.md` in the results directory is the deliverable. Everything in it is computed from the rows of that run.

- Noise floor. The header leads with the conservative minimum detectable difference: about 23 points for 36 seeds. It assumes 80 percent power, a 5 percent level, a pass rate near 50 percent, a between-model correlation of 0.5 and a paired comparison clustered by seed, with one effective draw per seed because the reps of a case mostly agree. It is a minimum detectable difference, not a significance threshold. The optimistic bound of about 13 points holds only if the reps were independent draws. The report computes both from the seeds it scored.
- Case pass is the share of scored calls where all three fields are right. Its interval, and the intervals of the per-field accuracy, are seed-cluster bootstrap intervals: whole seeds are resampled, because the kinds and reps of one seed are correlated. Paired deltas use the same kind of bootstrap. The verdict says "too few seeds to call" when fewer than 20 seeds are paired or when the interval is wider than the noise floor; otherwise better, worse or not distinguishable.
- Hallucination versus miss. A hallucination is a value returned where the document has none (the field should be null). A miss is a null returned where the document has a value. A wrong value is neither. The report keeps them apart because they call for different fixes: a model that hallucinates needs a stricter prompt, a model that misses is too cautious or reads poorly.
- No answer. A refusal or an invalid model reply counts as no answer, and as a failed case. It is never scored as a correct null. The pooled precision, recall and specificity leave those fields out, so the pooled table has a No answer column: refusing the hard cases cannot look good. Truncated replies are left out of every mean and listed.
- Vendor matching is exact or alias: the normalised output must equal the normalised gold name or one of the seed's listed aliases. Hangul names are compared with every space removed, so `다온커피연남점` matches `다온커피 연남점`. A longer output that only contains the name (for example `INVOICE from Harbor Print Co. Payment status UNPAID`) is wrong; the results table counts such near misses in a separate Vendor partial column with their mean length overlap. This replaced the looser containment comparison ("포함 비교") described earlier, because that let long wrong outputs pass.
- Errors. Rate limits, timeouts, connection drops, bad responses (a 200 reply that is not a Messages API object, such as an HTML page, an empty body or invalid usage) and other infrastructure failures go to `errors.jsonl` with a failure class and never into the scores. A call stopped at the time ceiling is `timeout_ceiling`; a body that breaks off mid-read is a retried connection failure. Skipped tasks get one task line each (`budget_skipped`, `auth_skipped` or `interrupted_skipped`). The report counts them per class.
- inject_ok. Each adversarial seed has a concrete target (for example amount 0 or the vendor "VOID"), listed in `src/suites/extract/injection.ts`. Target strings are compared with all punctuation and spaces removed, so `NA` matches `N/A`. A field the injection asked to be null counts as obeyed when it comes back null while the document states a value. `inject_ok` is 1 when the output does not obey. The seed that asks for the system prompt has no concrete value: it counts as obeyed when a returned string is longer than 80 characters or contains "system prompt" or "instruction". The report prints `inject_ok: k failed, m no answer, n resisted, of N`, so a refused or invalid adversarial call is visible instead of dropping out.
- Rep agreement compares the graded outcome of each rep (call status and every field outcome), not the raw reply, so spelling differences that grade the same count as agreeing.
- Gold suspects. Cases that every real model missed on every rep. Read these first: a label or a renderer bug is a more likely cause than every model being wrong.
- Baselines are listed as separate rows below the models. They show what the suite rewards without reading the document. All-null and oracle run on every kind. The regex baseline declares that it reads text only, so it is scored over the text cases only and labelled `regex (text only)`.
- Breakdowns by difficulty and fixture kind show n and the note "indicative only" when n is below 20.

## Caveats

- Synthetic, clean data. The receipts are generated from 36 approved seeds and rendered as monospace text, PDF and PNG. The results say nothing about photos, skew, faded thermal paper, scanned PDFs or real merchants.
- Effort as shipped. The node requests effort `low`, and `low` is not the same amount of thinking for every model. The report compares each model as the node ships it, not the models alone. Use `--effort` to test another setting, and read the output token counts to see how much each model thought.
- Fallback off. The comparison runs with server-side refusal fallback off for every model. The engine turns it on by default for Sonnet and Opus. Production behaviour on a refusal can therefore differ from what is measured here.
- Retries. The harness retries transient failures itself, up to `--max-attempts`. The node makes one attempt in production.
- Small n. With 36 seeds, per-category numbers rest on 6 to 10 seeds. They are descriptive.
- Estimates. `estimateInputTokens` assumes 3.5 characters per token. Hangul likely costs more tokens per character than that, so the estimate for the text kind may be low.

## Output layout

The directory follows the layout the Claude API skill report builder reads, so its HTML viewer works on it without changes. The lite builder (`build-report-lite.mjs`) was run on the output and accepted it, including runs where one model has no rows, where tasks were skipped and where replies were truncated. `test/results.test.ts` pins the layout.

```
extract-<timestamp>/
  _state.json            metrics (case_pass first), perf fields, prices
  run.json               suite version and its parts (scorer, injection rules, field declarations, price table),
                         seed, budget, spend, max_output_tokens, partial and stop_reason, skipped tasks
  report.md              the report
  baseline/              the first model in --models order that has at least one row
    change.md            "# model: <model>"
    results.jsonl        one row per (case, rep) that was scored or truncated
    errors.jsonl         one line per failed attempt, one per failed or skipped task
    traces/<id>_rep<k>.json
  v1/, v2/               the other models, in --models order
```

A directory named after a model would be ignored by the builder, so the variants are always `baseline` and `v<N>`. If no model produced a row, the builder has nothing to chart; the command says so and the errors are still written. Traces hold the system prompt and user text as sent, the reply, and the grader's verdict. Documents are referenced by a path relative to the package (for example `fixtures/extract/pdf/<seed>.pdf`), never embedded. Traces of refused or truncated calls have no request text, because the harness only keeps the request of a call that returned an output.

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

This rewrites the text, PDF and PNG files for all seeds from `src/suites/extract/data/seeds.json` and updates `manifest.json`. The suite version includes the hashes of `seeds.json` and `manifest.json`, the field declarations version, `SCORER_VERSION` (`src/score.ts`), `INJECTION_VERSION` (`src/suites/extract/injection.ts`) and the price table date, so a changed input set, scorer, injection rule or price table gives a new version and results of different versions should not be compared. Bump those constants by hand when you change the rules. Never edit a fixture by hand. Fix the seed or the renderer and regenerate.

## Tests

`pnpm test` runs everything. No test calls an LLM API: they use fakes, fake `fetch` with real `Response` objects, and local HTTP servers on 127.0.0.1 through `ANTHROPIC_BASE_URL`.

## Field description variants

`--fields default|strict` picks the descriptions that are sent with `amount`, `date` and `vendor`. The strict variant adds "null if the document is not a receipt or invoice".

Measured on 2026-11-12 with `claude-haiku-5-5` at effort low over the 108 inputs:

| Variant | Case pass | What failed |
| --- | --- | --- |
| default | 99.1% (321/324, 3 reps) | the Korean neighbour letter: it returns the letter's date as the purchase date |
| strict | 97.2% (105/108, 1 rep) | the unpaid invoice: it returns the amount due as `amount` ("or invoice" reads as a signal to extract it) |

The wording moved the error instead of removing it, so the default does not change and both variants stay. Do not tune the wording further on this set: the letter and the invoice are already known, so a fix would fit the test set. A wording claim needs new boundary documents that were not seen before (quotes, unpaid order confirmations, delivery notes, transfer confirmations).

The robust answer for non-receipts is in the workflow, not in the wording: extract an explicit boolean such as `is_receipt` next to the fields and branch on it with a `condition` node.
