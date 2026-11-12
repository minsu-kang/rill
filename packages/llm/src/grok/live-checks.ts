import type { LiveCheck } from '../descriptor'

export const LIVE_CHECKS: readonly LiveCheck[] = [
  {
    id: 'usage-output-total',
    what: 'Whether total_tokens minus input_tokens equals output_tokens plus reasoning_tokens on a reasoning call. The adapter reports that difference as the output count, including reasoning; the report infers that output_tokens excludes reasoning and the OpenAPI text describes total_tokens as prompt plus completion only.',
  },
  {
    id: 'usage-cached-subset',
    what: 'Whether input_tokens already includes input_tokens_details.cached_tokens. The adapter subtracts the cached tokens from the input and reports them as the cache read; the report infers this from examples and the Anthropic-compatible endpoint.',
  },
  {
    id: 'image-data-url',
    what: 'Whether an inline base64 data URL image (png and jpeg) is accepted with store false and reasoning on. The guides show public URLs and data URLs for images but warn that stored image requests may fail; the inline file_data form is unused because PDFs are refused.',
  },
  {
    id: 'effort-xhigh',
    what: 'Whether grok-4.5 and grok-4.3 accept reasoning effort xhigh. The model page says yes; the reasoning page says grok-4.5 treats xhigh as high; the retirement notice lists no xhigh for grok-4.3. The model table sends high on grok-4.5 and xhigh on grok-4.3.',
  },
  {
    id: 'effort-none',
    what: 'Whether grok-4.3 accepts reasoning effort none. The adapter never sends none because the effort scale has no such level; the pages disagree on whether it exists.',
  },
  {
    id: 'output-limits',
    what: 'The real ceiling for max_output_tokens per model and whether the context window is shared between prompt and output. No model page lists a maximum; the request default is documented as 128,000.',
  },
  {
    id: 'terminal-event-shape',
    what: 'Whether the response.completed and response.incomplete stream events carry the response object under a response field, which is how the adapter reads them (a flat event is accepted too), and whether the event type is also repeated in the data.',
  },
  {
    id: 'stream-error-shape',
    what: 'How a failure after the stream has started is reported: the shape of an error event and of a response.failed event, and which text or code marks an overloaded service. The adapter guesses the kind from the code and the message and keeps every unrecognised failure as unknown.',
  },
  {
    id: 'context-too-long-error',
    what: 'The HTTP status and error code for an input that exceeds the context window, and whether a policy block before generation is an error response. The adapter recognises the message text and reports invalid_request; the report documents neither.',
  },
  {
    id: 'schema-limits',
    what: 'The undocumented schema limits: nesting depth, total property count, schema size and enum count. The adapter enforces none of them locally and only refuses recursion, empty enums or anyOf, boolean property schemas, minContains, maxContains and tuple items.',
  },
  {
    id: 'incomplete-reasons',
    what: 'What incomplete_details.reason max_prompt_tokens and max_time_limit really mean. The adapter reports the first as an input that is too long (invalid_request) and the second as a provider-side time limit (timeout); the report infers both meanings and does not give the time limit.',
  },
  {
    id: 'cache-write-unreported',
    what: 'That usage carries no cache creation field and that cache writes are not billed. The adapter reports zero cache write tokens and the price table assumes a cache write price of zero; both rest on the absence of any documented field.',
  },
  {
    id: 'served-model-id',
    what: 'What response.model reports for the alias the adapter sends (the same alias or a dated id), since retired ids are redirected to grok-4.3 without notice and the adapter only reports the id it receives.',
  },
  {
    id: 'stream-idle-gap',
    what: 'The longest silent gap between stream chunks during reasoning at medium and high effort, against the 300 second body timeout of the Node fetch implementation. Only the whole-call deadline is applied by the adapter.',
  },
  {
    id: 'cache-hit',
    what: 'Whether a second call with the same system text and the prompt_cache_key derived from it reports cached_tokens above zero. The minimum cacheable prefix, the time to live and whether the response schema belongs to the cached prefix are not documented.',
  },
]
