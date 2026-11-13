# @rill/llm (packages/llm)

Owns the `LlmProvider` interface, its adapters for Anthropic, OpenAI, Gemini, Grok and Meta, the model table with declared capabilities, and the dated price table. [README.md](README.md) lists the models, capabilities and wire notes.

## Run

- `pnpm exec vitest run packages/llm`

## Rules

- Tests use fake transports only: they inject a `FetchFn` from `test/fake-transport.ts`. No test may reach the network.
- Every adapter passes the shared suite `describeProviderConformance` in `test/conformance.ts`: usage buckets, effort levels, stop reasons, deadlines and retries. `test/conformance.meta.test.ts` proves the suite catches deliberate faults in a reference adapter.
- Only the Anthropic adapter has been called live, by the extraction evaluation. The OpenAI, Gemini, Grok and Meta adapters are built from vendor documentation and fake transports.
- Each fact an adapter relies on and the documentation does not settle is an entry in its `LIVE_CHECKS`, for example in `src/grok/live-checks.ts`. Add an entry for every new assumption. A person measures them with `pnpm eval check-provider` and their own key.
- A key reaches an adapter only through its constructor options or the `env` object passed to `createProvider` (`src/registry.ts`). Nothing in `src` reads the process environment, and a key never appears in an error message (the `leak-key` fault in `test/conformance.meta.test.ts`).
- Retries belong to the adapter (`src/retry.ts`). Only `rate_limit`, `overloaded` and `connection` errors are retried, at most `MAX_RETRIES` times, and never after the first streamed event.
- A model whose id ends in `-contributor` is refused for every provider (`src/registry.ts`), because those models train on your content.
- A model needs an entry in its provider's model list (`src/<provider>/models.ts`, or `src/anthropic-descriptor.ts` for Anthropic) and a price in `src/pricing.ts`. The evaluation refuses `--yes` for a model without a price.

## Do not

- Do not add a call to a live endpoint to a test, a script or a default.
- Do not read `process.env` in an adapter or in the registry.
- Do not log or return a key, or a request body that holds one.
