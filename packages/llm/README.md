# @rill/llm

One interface, `LlmProvider`, over five model providers: Anthropic, OpenAI, Google Gemini, xAI Grok and Meta. A call takes messages (text, images, PDFs) and a JSON schema and returns the parsed data, the token usage in four buckets and the model that answered. Every provider declares what it can do, so callers can degrade with a clear message instead of failing in the middle of a request.

What it does not do: tool calling, batch or flex tiers, multi-turn state kept by the vendor (every request is stateless), and local models (no Ollama, no hosted Llama). The Anthropic provider is the default everywhere.

## Use it

```ts
import { createProvider, capabilitiesOf, listModels } from '@rill/llm'

const provider = createProvider('openai:gpt-6.1-sol', { env: process.env })
const result = await provider.generate({ messages: [{ role: 'user', content: 'Hi' }], schema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'], additionalProperties: false } })
capabilitiesOf(provider).documents // 'native-pdf' or 'none'
```

- A model spec is `provider:model`. A bare id is an Anthropic model (`claude-opus-5-5`).
- `createProvider` reads the key from the environment object you pass, in the variable named by the provider's descriptor (table below). A missing or blank key throws `LlmError('auth')`. The registry and the OpenAI, Gemini, Grok and Meta adapters never read `process.env`. An `AnthropicProvider` built directly without a key lets the Anthropic SDK read its own variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`), which is what the engine CLI relies on.
- An unknown provider, an unknown model (for every provider except Anthropic) and any id that ends in `-contributor` throw `LlmError('invalid_request')` before the key is looked at. The message lists the known values.
- `listModels()`, `findModel(spec)` and `providerDescriptor(id)` expose the model table without creating a provider.
- Errors are `LlmError` with a `kind`: `auth`, `rate_limit`, `overloaded`, `connection`, `timeout`, `invalid_request`, `refusal`, `truncated`, `invalid_output`, `aborted` or `unknown`. A key never appears in a message.

## Providers

| Provider | Key variable | Built on | Endpoint |
| --- | --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` | `@anthropic-ai/sdk` | Messages |
| `openai` | `OPENAI_API_KEY` | `openai` 7.45.1 (`maxRetries: 0`) | `POST /v1/responses` |
| `gemini` | `GEMINI_API_KEY` | `@google/genai` 2.31.0 | Interactions API, `ai.interactions.create` |
| `grok` | `XAI_API_KEY` | plain `fetch` | `POST https://api.x.ai/v1/responses` |
| `meta` | `META_API_KEY` | plain `fetch` | `POST https://api.meta.ai/v1/chat/completions` |

The OpenAI, Gemini, Grok and Meta adapters set their SDK retries to zero and retry by themselves, so one attempt is one billed request. Only `rate_limit`, `overloaded` and `connection` errors are retried, at most twice, and never after the first streamed event. A `retry-after` hint is honoured up to 60 seconds, with jitter. The per-call `timeoutMs` is a deadline for the whole call, and an `AbortSignal` stops it. The Anthropic provider is unchanged: it uses the Anthropic SDK's own retry behaviour unless you pass `maxRetries`, which the eval harness does.

The Meta variable name is a choice made here. Meta's own documentation calls it `MODEL_API_KEY`, and its keys begin with `LLM_`.

Where to get a key: each vendor's developer account. The research behind these adapters did not record the key pages, so this repository does not guess them. The documentation hosts it read are `developers.openai.com`, `aistudio.google.com/docs`, `docs.x.ai` and `dev.meta.ai/docs` (Meta's authentication page is `dev.meta.ai/docs/authentication`).

### Capabilities

| Provider | Structured output | PDF | Images | Cache | Effort levels | Streaming | Reasoning counted in `maxTokens` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `anthropic` | strict | native | png, jpeg, gif, webp | explicit, 4 breakpoints | low to max, one to one | optional | yes |
| `openai` | strict | native, 50,000,000 bytes of PDF per request | png, jpeg, gif, webp | explicit, 3 breakpoints | low to max, one to one | optional | yes |
| `gemini` | strict | native, 75,000,000 bytes per request | png, jpeg, webp | automatic | low, medium, high | always | yes |
| `grok` | strict | none | png, jpeg | automatic | low to xhigh (low to high on `grok-4.5`) | always | no |
| `meta` | strict | native, 50,000,000 bytes per request | png, jpeg, gif, webp | automatic | low to max (low to xhigh on Spark 1.2 and 1.1) | always | yes |

The levels a model does not distinguish are sent as the nearest lower one: Gemini sends `xhigh` and `max` as `high`, Grok sends `max` as `xhigh` (as `high` on `grok-4.5`), Meta sends `max` as `xhigh` on Spark 1.2 and 1.1. `capabilities.effortLevels` lists what a model really distinguishes and `capabilities.effortMap` the value that goes on the wire. The planner reports a collapsed level in its plan meta.

### Models

| Provider | Model | Tier | Context tokens | Maximum output |
| --- | --- | --- | --- | --- |
| `anthropic` | `claude-haiku-5-5` | cheap | 1,000,000 | 128,000 |
| `anthropic` | `claude-sonnet-5-5` | mid | 1,000,000 | 128,000 |
| `anthropic` | `claude-opus-5-5` | strong | 1,000,000 | 128,000 |
| `openai` | `gpt-6-astra` | strong | 1,050,000 | 128,000 |
| `openai` | `gpt-6.1-sol` | mid | 1,050,000 | 128,000 |
| `openai` | `gpt-6.1-terra` | mid | 1,050,000 | 128,000 |
| `openai` | `gpt-6-luna` | cheap | 1,050,000 | 128,000 |
| `gemini` | `gemini-4-carbon` | strong | 1,048,576 | 65,536 |
| `gemini` | `gemini-4-argon` | strong | 1,048,576 | 65,536 |
| `gemini` | `gemini-3.8-flash` | mid | 1,048,576 | 65,536 |
| `gemini` | `gemini-3.5-flash-lite` | cheap | 1,048,576 | 65,536 |
| `grok` | `grok-4.7` | strong | 500,000 | not listed |
| `grok` | `grok-4.6` | strong | 500,000 | not listed |
| `grok` | `grok-4.5` | strong | 500,000 | not listed |
| `grok` | `grok-4.3` | mid | 1,000,000 | not listed |
| `meta` | `muse-wonder-1.0` (preview) | strong | 1,048,576 | not listed |
| `meta` | `muse-spark-1.3` | mid | 1,048,576 | not listed |
| `meta` | `muse-spark-1.2` | mid | 1,048,576 | not listed |
| `meta` | `muse-spark-1.1` | mid | 1,048,576 | not listed |
| `meta` | `muse-ember-1.0` | cheap | 1,048,576 | 524,288 |

The table is `MODEL_TABLE` in `src/models.ts`, built from one `models.ts` per provider folder. Prices are in `src/pricing.ts`, dated (`PRICE_TABLE_AS_OF`) with effective-date tiers where a vendor announced a price change. A price field that no vendor page states is listed in the entry's `assumed` array.

## Wire format notes

- **OpenAI.** System blocks go into one developer-role input message. `store: false` is always sent. Temperature, `top_p` and logprobs are never sent. The schema goes through `strictify` (every property required, optional ones nullable, `additionalProperties: false`) and the reply is restored afterwards. PDFs are `input_file` parts with a `data:application/pdf;base64,` URL. Reasoning counts inside `max_output_tokens`. Usage: `input_tokens` includes cached and written tokens, so both are subtracted from the uncached input. At most three `prompt_cache_breakpoint` markers are sent and the rest are dropped.
- **Gemini.** Always streams, always `store: false`. The schema goes through `dropUnsupported`, so keywords Gemini ignores are removed and local validation stays the judge. Thought tokens are reported apart from the output, so they are added to the output bucket, and cached tokens are subtracted from the input. Earlier assistant turns are replayed as text only. No assistant prefill, no temperature, no `top_k`. A PDF is limited to 50,000,000 bytes, and a request to 3,600 images.
- **Grok.** Always streams, always `store: false`. A PDF is refused before any request with `this provider does not read PDF files`. Images are limited to 20 MiB each. `prompt_cache_key` is a hash of the system text and never contains user text. Hidden reasoning is not capped by `maxTokens`, so cost and duration have a soft ceiling only (see Known gaps). Usage output is `total_tokens - input_tokens`. A stream that ends without `response.completed` or `response.incomplete` is a `connection` error. The client timeout is 900 s at least, and the call's own deadline wins through the abort signal.
- **Meta.** Always streams with `stream_options.include_usage`. `response_format` is `json_schema` with `strict: false`, which the report says currently behaves like `true`. `reasoning_effort` is always sent and never `none`. A PDF is a `file` part with a data URL, and Meta renders its pages as images, which count against a limit of 50 images per request. The adapter counts them conservatively, up to 50 per PDF and the maximum for a PDF whose pages it cannot count, and rejects a request over the cap with a clear message. `prompt_cache_key` is derived from the system text.
- **All.** A truncated reply (`max_tokens`, `length`, `MAX_TOKENS`, `incomplete`) is `truncated`, a refusal or a safety block is `refusal`, and a reply that is not valid JSON is `invalid_output` with the billed usage attached. HTTP 401, 402 and 403 are `auth` by default (402 is reported as a billing or credit problem).

## Privacy notes

`capabilities.dataNote` is one sentence for the UI. These are the ones in the code:

| Provider | Note |
| --- | --- |
| `anthropic` | Your content is sent to the Anthropic API and handled under your Anthropic account terms. |
| `openai` | OpenAI says API data is not used to train its models and may be kept for up to 30 days for abuse monitoring, unless your organization has zero data retention. The adapter sends `store: false` on every request. |
| `gemini` | With a free Gemini key Google may use your content for training and human review. Paid keys are not used for training but are logged for a limited time to catch abuse. |
| `grok` | xAI keeps API requests and responses for 30 days for abuse monitoring and says it does not train on them without your permission. The adapter sends `store: false` on every request. |
| `meta` | Meta says it does not train on Standard-mode API content but keeps it as needed for service and safety review, and flagged content can be kept for up to two years. Models whose id ends in `-contributor` train on your content, so the registry refuses them for every provider. Muse Wonder is a preview model and is not available in South Korea. |

A key reaches an adapter only through its constructor options. It is not put into an error message, a log line, a recorded exchange or a test snapshot, and each adapter has a test for that.

## Add a provider

1. Add the id to `PROVIDER_IDS` and `ProviderId` in `src/capabilities.ts`, and to `ProviderIdSchema` in `@rill/protocol`. TypeScript then points at the other places that list providers, such as the host table in `@rill/eval`.
2. Create `src/<id>/` with `models.ts` (a `ModelInfo` per model with its `LlmCapabilities` and a `dataNote`), `request.ts`, `reply.ts` (stop reasons to `LlmError`, usage to the four buckets through `normaliseUsage`), `provider.ts` (the `LlmProvider`), `exchange.ts` (an `ExchangeParser` the eval recorder uses), `live-checks.ts` and an `index.ts` that exports a `ProviderDescriptor`.
3. Build the HTTP side from the shared plumbing: `postJson` or `postStream` over an injected `fetch`, `readSse`, `classifyHttp`, `withRetry`, `startDeadline` and the schema helpers `strictify`, `dropUnsupported` and `checkSchemaLimits`. Take `fetch`, `sleep` and `random` from the constructor options so tests need no network and no real clock.
4. Register the descriptor in `DEFAULT_DESCRIPTORS` in `src/registry.ts`, add the models to `src/models.ts`, add prices to `src/pricing.ts` and export the descriptor from `src/index.ts`.
5. Write the wire fixtures and run the shared suite over the adapter. `describeProviderConformance` in `test/conformance.ts` takes a builder and the vendor's canned replies and checks the happy path, usage buckets, PDF and image parts, cache flags, each effort level, the stop reasons, the error kinds, retries, abort, the deadline, that the key never appears in an error, golden request bodies and that no timer or reader is left open. `test/openai.conformance.test.ts` is the shortest example.
6. List every fact you could not confirm from the vendor's documentation in `LIVE_CHECKS`, and add an evaluator for it to `LIVE_EVALUATORS` in `packages/eval/src/check-provider.ts` where one can be measured.

Anything in a vendor report that is inferred or unknown, and that the adapter relies on, belongs in `LIVE_CHECKS`. A documented fact can be built on directly.

## LIVE_CHECKS and check-provider

Each adapter exports `LIVE_CHECKS: { id: string; what: string }[]`. An entry is something the adapter depends on but the vendor documentation does not settle, for example whether `completion_tokens` includes reasoning tokens. At the time of writing the counts are OpenAI 11, Gemini 19, Grok 15 and Meta 12; Anthropic declares none.

**All of these checks are UNVERIFIED. None of the four adapters that declare them has been called live.** The adapters were built and tested against fake transports and the vendors' documented examples. Until someone runs `check-provider` with a real key, treat these four adapters as untested against the real service.

`pnpm eval check-provider --provider <id> --model <id> --yes` sends at most four small calls and prints each entry with the measured value and PASS, FAIL or UNKNOWN:

1. text with a schema that has an optional field (the `strictify` and `restore` round trip),
2. the same call again with a cached prefix, to see a cache read,
3. an image,
4. a PDF, or for a model that reads no PDF a request that must be refused before anything is sent.

It needs the provider's key variable, applies a budget (default $0.25, `--budget-usd`), and stops before a call whose worst case does not fit. `--dry`, which is also what happens without `--yes`, prints the plan and the cost and sends nothing. An entry that no call can measure stays UNKNOWN and says so. See the eval README for the options and the output.

## Known gaps

- No tool calling, no batch or flex tiers, no Ollama, no hosted Llama (the Llama API is gone and Meta no longer serves Llama through its Model API).
- Nothing has run against a live endpoint, so the usage semantics, the schema limits, the cache minimums and the error shapes noted in `LIVE_CHECKS` are the vendors' documentation, not measurements.
- Grok does not read PDFs, and there is no local PDF text extraction. A PDF sent to Grok is a clear error, and the planner and `llm.extract` check the capability before any request.
- Grok hidden reasoning is not capped by `maxTokens`. The planner adds headroom, the eval budget guard reserves twice the output, and the cost it reports for Grok is a soft-cap figure.
- Gemini GIF input is excluded until it is checked, because the vendor pages disagree.
- Free-tier Gemini keys may be used for training. The adapter cannot tell a free key from a paid one.
