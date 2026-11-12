import type { LiveCheck } from '../descriptor'

export const LIVE_CHECKS: LiveCheck[] = [
  {
    id: 'pdf-schema-reasoning',
    what: 'A PDF input_file, a strict json_schema and reasoning.effort in one request work on gpt-6.1-sol and gpt-6-luna. The report infers it (no restriction is documented) and the GPT-6 model pages do not list PDF input.',
  },
  {
    id: 'schema-error-code',
    what: 'The exact HTTP status, error.type and error.code OpenAI returns for a strict schema it rejects (for example one that uses allOf). The adapter only relies on a 400 and shows error.param in the message.',
  },
  {
    id: 'unlisted-schema-keywords',
    what: 'Whether oneOf, const, default, minLength and maxLength are accepted under strict: true. The adapter does not send them: oneOf becomes anyOf, const becomes a one-value enum, default, minLength and maxLength are dropped.',
  },
  {
    id: 'sampling-parameters',
    what: 'Whether temperature and top_p are rejected with a 400 or ignored on the GPT-6 models. The adapter never sends them.',
  },
  {
    id: 'request-size-cap',
    what: 'Whether the 50 MB combined file limit counts raw PDF bytes or the base64 payload, and whether a larger request body cap exists. The adapter checks the decoded PDF bytes against 50,000,000.',
  },
  {
    id: 'breakpoint-on-file-and-image',
    what: 'Whether prompt_cache_breakpoint on an input_file or input_image block creates a cache write, and how it shows in input_tokens_details.cache_write_tokens. The API reference allows the field there, the caching guide only shows input_text.',
  },
  {
    id: 'explicit-breakpoint-limit',
    what: 'How many explicit prompt_cache_breakpoint markers a request may carry next to the implicit one. The adapter sends at most 3 (4 cache writes per request minus the implicit slot) and drops the rest.',
  },
  {
    id: 'stream-terminal-event',
    what: 'The response.completed, response.incomplete and response.failed events of a stream carry the whole response, including output and usage. The adapter reads the result from that event and does not assemble text from deltas.',
  },
  {
    id: 'context-overflow-error',
    what: 'The status, error.type, error.code and message OpenAI returns when the input is too long (the report expects a 400 invalid_request_error with param input). The adapter maps any 400 to invalid_request.',
  },
  {
    id: 'assistant-history-replay',
    what: 'Replaying an earlier assistant turn as plain string content in input (no reasoning items) is accepted and does not change the reply quality. The report infers it is enough because no tools are used.',
  },
  {
    id: 'animated-gif',
    what: 'How an animated GIF input_image is handled. The adapter declares image/gif, the documentation says non-animated GIFs only.',
  },
]
