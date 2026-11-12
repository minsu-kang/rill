import type { LiveCheck } from '../descriptor'

export const LIVE_CHECKS: readonly LiveCheck[] = [
  {
    id: 'completion-tokens-include-reasoning',
    what: 'completion_tokens already includes completion_tokens_details.reasoning_tokens. The adapter reads completion_tokens as the whole output and only raises it to reasoning_tokens when that is larger.',
  },
  {
    id: 'schema-with-reasoning-pdf-and-streaming',
    what: 'A json_schema response format works together with reasoning, a PDF file part and streaming in one request. The vendor documents none of these combinations, and every request uses all of them.',
  },
  {
    id: 'strict-false-optional-properties',
    what: 'response_format with strict false accepts a schema whose properties are not all required, and the reply still follows it. The planner schema has optional properties and is sent unchanged.',
  },
  {
    id: 'strict-false-oneof-allof',
    what: 'oneOf and allOf are accepted and followed with strict false. The vendor lists them as unsupported only for strict true, so the adapter does not reject them locally.',
  },
  {
    id: 'file-part-next-to-text',
    what: 'A file part and a text part can share one user message. The vendor shows content part arrays but never says so for files.',
  },
  {
    id: 'cache-minimum-and-ttl',
    what: 'The smallest prefix that is cached and how long it stays: the second identical call should report prompt_tokens_details.cached_tokens above zero. The vendor publishes neither value.',
  },
  {
    id: 'max-output-spark-and-wonder',
    what: 'The largest max_completion_tokens that muse-spark-1.3 and muse-wonder-1.0 accept. The vendor documents 524288 only for muse-ember-1.0 and answers 400 above the limit.',
  },
  {
    id: 'regional-availability',
    what: 'Which of the three current models answer from the key and region in use. A model that is not offered answers 403, and muse-wonder-1.0 is documented as unavailable in South Korea.',
  },
  {
    id: 'effort-levels-per-model',
    what: 'Every reasoning_effort value rill sends (low, medium, high, xhigh, and max where the model table allows it) is accepted by each model. The vendor lists per-model support only for max.',
  },
  {
    id: 'refusal-with-constrained-decoding',
    what: 'How a refusal looks when a schema is set: finish_reason content_filter or message.refusal. The vendor does not describe refusals for text replies.',
  },
  {
    id: 'stream-error-event-shape',
    what: 'The shape of an error event inside a Chat Completions stream. The adapter reads an event named error or response.failed, or a chunk with an error object, and treats anything else as a connection failure.',
  },
  {
    id: 'first-event-and-stream-limits',
    what: 'How long the first stream event may take, and any limit on a long stream. The vendor publishes no seconds, so only the whole-call deadline applies.',
  },
]
