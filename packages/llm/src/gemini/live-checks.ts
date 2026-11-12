import type { LiveCheck } from '../descriptor'

export const LIVE_CHECKS: readonly LiveCheck[] = [
  {
    id: 'usage-input-includes-cached',
    what: 'Does usage.total_input_tokens include total_cached_tokens? The adapter subtracts the cached tokens from the input, so a second call with the same prefix must show input minus cached as the uncached share.',
  },
  {
    id: 'usage-thoughts-separate',
    what: 'Are total_thought_tokens reported apart from total_output_tokens (total_tokens = input + output + thought)? The adapter adds the two to get output tokens including reasoning.',
  },
  {
    id: 'implicit-cache-minimum-flash-lite',
    what: 'What is the smallest prefix that gets an implicit cache hit on gemini-3.5-flash-lite? The report gives 4096 tokens for Carbon, Argon and 3.8 Flash only; the TTL and the hit guarantee are not published either.',
  },
  {
    id: 'gif-support',
    what: 'Are image/gif parts accepted? The image guide omits GIF and the API reference lists it, so the adapter refuses GIF until this passes.',
  },
  {
    id: 'xhigh-acceptance',
    what: 'Does any model accept thinking_level "xhigh"? The SDK types list it, no documentation does, so the adapter sends high for xhigh and max.',
  },
  {
    id: 'schema-compile-latency',
    what: 'How long does the first request with a new, large response schema take compared with the second one with the same schema? The documentation gives no figure.',
  },
  {
    id: 'schema-limits',
    what: 'Where does a response schema become too complex (depth, property count, enum values, size)? No numeric limit is published, so the adapter enforces none and relies on the 400 reply.',
  },
  {
    id: 'schema-error-location',
    what: 'Does the 400 reply for a too-complex schema name a location, and in what form? The adapter quotes a JSON pointer or a dotted schema path when the message has one.',
  },
  {
    id: 'schema-keywords-unlisted',
    what: 'How are pattern, oneOf, const and format values other than date, date-time and time treated in a response schema? They are not listed as supported or ignored, so the adapter sends them unchanged.',
  },
  {
    id: 'replay-assistant-text-only',
    what: 'Is a multi-turn input accepted when earlier model_output steps carry only text, with no thought steps or signatures resent? The adapter replays assistant turns as text steps in a stateless request.',
  },
  {
    id: 'pdf-schema-reasoning-together',
    what: 'Do a PDF document part, a JSON response schema and thinking work together in one request? The report infers it from separate model-page entries.',
  },
  {
    id: 'inline-request-limit',
    what: 'What inline payload size is accepted: 100 MB (50 MB per PDF) as the file-input guide says, or 20 MB as the image and batch guides say, and is it measured before or after base64? The adapter caps raw bytes at 75 MB.',
  },
  {
    id: 'non-streaming-output-cap',
    what: 'Note only, the adapter always streams: the output cap for Gemini 4 is 65,536 streaming and 32,768 non-streaming on two pages, and 65,536 for both on a third.',
  },
  {
    id: 'invalid-key-response',
    what: 'What status and body does a rejected API key get? The adapter reads a 400 that says the API key is not valid, invalid or expired as an auth error.',
  },
  {
    id: 'retry-delay-hints',
    what: 'Does a 429 carry a Retry-After header or a RetryInfo.retryDelay in its body? Neither is in the vendor documentation; the adapter uses either when present.',
  },
  {
    id: 'context-too-long-response',
    what: 'What status does a prompt over the context window get? The documentation shows a 500 INTERNAL "input context is too long" example; the adapter treats any such message as an invalid request.',
  },
  {
    id: 'served-model-id',
    what: 'Does the model field of the reply echo the requested id exactly? The adapter calls any difference a fallback.',
  },
  {
    id: 'stream-text-location',
    what: 'Does the answer text arrive only in step.delta text events, and does each event carry event_type in its data? The adapter follows the SDK types and falls back to the steps of the final event.',
  },
  {
    id: 'interactions-default-schema',
    what: 'Does a request sent without an Api-Revision header, to /v1beta/interactions, return the steps-based schema the adapter reads? SDK 2.31.0 sends no such header.',
  },
]
