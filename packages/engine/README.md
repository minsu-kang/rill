# @rill/engine

The durable workflow engine, its WebSocket server and the `rill-engine` command line. The wire protocol and its schemas live in `@rill/protocol`.

## Command line

    rill-engine run <workflow.json> [--db <path>] [--payload <json>] [--dry-run] [--allow <dir>]... [--connections <file.json>]
    rill-engine watch <workflow.json> [--db <path>] [--allow <dir>]... [--connections <file.json>] [--port <n>]
    rill-engine serve [--db <path>] [--allow <dir>]... [--connections <file.json>] [--attachments-dir <dir>] [--port <n>] [--webhook-port <n>] [--shutdown-timeout <ms>]
    rill-engine recover [--db <path>] [--allow <dir>]... [--connections <file.json>]

`serve` listens on 127.0.0.1 and reads its access token from `RILL_TOKEN` (16 or more characters). When the variable is not set it prints a generated token in its first output line.

Every command also accepts `--llm-provider <id>`, `--llm-model <id>` and `--llm-no-fallback`, described under Model provider.

### Connections file

A JSON object that maps a connection name to a secret string, or to an object with a kind:

    {
      "office": "https://hooks.example.test/abc",
      "team": { "secret": "https://hooks.example.test/def", "kind": "slack" }
    }

Nodes can use both forms. The planner is told only about the second form, by name and kind (`slack`, `http` or `webhookSecret`), and never receives a secret. A bad kind or a secret that is not a string stops the command with a usage error.

### Model provider

The provider and model serve `llm.extract` steps in every command and the planner in `serve`.

| Flag | Meaning |
| --- | --- |
| `--llm-provider <id>` | One of `anthropic` (the default), `openai`, `gemini`, `grok`, `meta`. |
| `--llm-model <id>` | A model of that provider. Defaults to `claude-opus-5-5` for `anthropic` and is required for every other provider. |
| `--llm-no-fallback` | Turns off the Anthropic refusal fallback. It has no effect on the other providers, which have no fallback. |

The key comes from the environment, in the variable of the chosen provider:

| Provider | Key variable |
| --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` (`ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` are read by the Anthropic SDK as before) |
| `openai` | `OPENAI_API_KEY` |
| `gemini` | `GEMINI_API_KEY` |
| `grok` | `XAI_API_KEY` |
| `meta` | `META_API_KEY` |

- An unknown provider, an unknown model of a provider other than `anthropic`, and any model id that ends in `-contributor` stop the command with a usage error (exit 2) that lists the known values. This happens before the key is looked at.
- `anthropic` keeps its earlier behaviour: the provider is always built, and a missing key shows up as an authentication failure when a call is made.
- For any other provider a missing or blank key is not an error and the engine never asks for one. The CLI prints one line on stderr that names only the variable (for example `XAI_API_KEY is not set; planning and llm.extract are unavailable`). The engine starts with no model provider: `plan` fails with `LLM_UNAVAILABLE`, and an `llm.extract` step fails with `llm.extract needs an LLM provider; start the engine with --llm-provider and its key variable`.
- The CLI passes the process environment to the registry once at start and hands the engine only which providers have a key and which model is active (`EngineOptions.llmInfo`, built with `chooseLlm` and `configuredProviders`). The engine keeps no key outside the provider object.

### Planning

`serve` answers the planner methods below with the provider chosen above. Without a key for it, `plan` fails with `LLM_UNAVAILABLE`.

The planner only proposes file paths inside the `--allow` folders. With no `--allow` it cannot propose reading or writing files.

`--attachments-dir` is the folder the engine reads plan attachments from. It is created with mode 0700 when it is missing, and it must be inside an `--allow` folder when any is given. Without it, a `plan` request that carries attachments fails with `ATTACHMENT_REJECTED`.

## Model methods

| Method | Params | Result |
| --- | --- | --- |
| `llmModels` | none | `models`, `providers`, `active` |

`llmModels` answers what a client needs to offer a choice of model without knowing the provider code:

- `models`: every model of the registry with `provider`, `id`, `tier` (`strong`, `mid`, `cheap`), `label`, `contextTokens` and `capabilities` (structured output, PDF and image support, request size cap, cache mode, the effort levels the model distinguishes and the value each level is sent as, whether reasoning counts against the output cap, streaming, maximum output, and `dataNote`, one sentence about what the vendor does with the content). Plain data, no functions.
- `providers`: one entry per provider with `id`, `label`, `keyEnv` (the name of the variable, never its value) and `configured` (a key is present in the environment the engine was started with).
- `active`: `{ provider, model }` of the model the engine uses, or `null` when the engine has no model provider. For `anthropic` without a key it is still set, and `configured` for `anthropic` is `false`.

No key, header or part of a key appears in the result, in an event or in a log line. An engine started without `llmInfo` reports every provider as not configured and `active` as `null`, even when it was given a ready `llm` provider that plans fine; an embedder that wants `llmModels` to be accurate passes `llmInfo` too.

`PROTOCOL_VERSION` is still 1 and the result schemas are closed, so a client and an engine have to be built from the same commit: a client from before the optional `PlanMeta` fields (`provider`, `effortDetail`, `reasoningCapped`, `costNote`) rejects `plan` and `getPlan` results that carry them. Nothing ships yet that mixes versions.

## Planner methods

Five methods turn a request into a workflow and deploy it after the user has confirmed what needs confirming. Every request is a normal protocol request, so the 1 MiB message limit applies.

| Method | Params | Result |
| --- | --- | --- |
| `plan` | `planId`, `text`, `turns`, `attachments`, `effort`, optional `workflowId`, `selection` and `useMemory` | `planId`, `result`, `meta` |
| `cancelPlan` | `planId` | `cancelled` |
| `getPlan` | `planId` | `plan` (the stored record) |
| `listPlans` | optional `limit` (1 to 200) | `plans` (summaries, newest first) |
| `deployPlan` | `planId`, `confirmed` | `workflowId` |

### plan

The client chooses `planId`, which must be unused. The engine keeps no conversation: every call carries its own `turns`, at most 40. A turn holds at most 10 questions with 10 options each, and at most 10 answers of up to 8000 characters. `text` is 1 to 8000 characters and `effort` is one of `low`, `medium`, `high`, `xhigh` and `max`. Setting `workflowId` gives the planner the stored workflow as context, and adding `selection` (a node id) asks for a patch to that node instead of a new workflow.

`result.kind` is `workflow`, `questions` or `unsupported`. A workflow result carries `flags` and `needsConfirmation`. At most 2 plans run at the same time; a further one fails with `PLAN_BUSY`. A client that disconnects does not cancel its plan, and the record stays readable through `getPlan`.

### Attachments

Attachment bytes never travel over the protocol. Put the file into the attachments folder as `<id>.<ext>`, where `id` is 8 to 64 characters from A-Z, a-z, 0-9, `_` and `-`, and `ext` is 1 to 8 lowercase letters or digits. Then send the reference `{ id, mediaType, name, bytes }` in `attachments` (at most 5 per message, 10 per conversation). The limits are the ones of `llm.extract`: 20 MiB for a PDF, 3.75 MiB for an image and 1 MiB for text.

The engine reads a file only when exactly one file matches the id, it is a regular file, and it is not a symbolic link. Plan records keep the four reference fields and nothing from the file.

The free text of a result (the summary, the question texts, options and defaults, the reason and the nearest node) is scrubbed before it is returned and stored: identifiers and links that occur in a text attachment, and words that only a text attachment has (not the user's messages, the catalog or the existing workflow), become `<hidden>`. A PDF or an image cannot be searched, so words taken from one are not found. The workflow itself is not changed: a value in it that came from an attachment carries a flag.

### Flags and confirmation

A flag marks a node field whose value did not come from the user's own words (`attachment_origin`, `new_egress_target` or `untrusted_flow`). Each flag has a key, `flagKey(flag)` from `@rill/protocol`, which is the JSON text of `[nodeId, pointer, code]`.

`deployPlan` deploys the planned workflow only when `confirmed` contains every flag key of the plan and nothing else. Otherwise it fails with `PLAN_NOT_CONFIRMED`, and the message names the unconfirmed flags by node and pointer, never by value. It does not activate the workflow or start a run; use `activate` and `startRun` (with `dryRun`) for that.

`deploy` refuses the content of a plan that has flags and has not been deployed yet, with the same error. The comparison ignores the workflow name, key order, the order of the nodes and edges, and an `onError` or `retry` that only spells out the default. It stops accidental deploys, not a client that edits the content first.

### Records and errors

A record has the status `planned`, `failed` or `cancelled`, the effort, the request text, the attachment references, the ids of the memory notes the plan loaded (`memoryIds`), the result and the meta of a planned record, and the confirmed keys once it is deployed. A failed or cancelled record keeps a fixed error text and the redacted repair rounds, never the model's reply.

The meta of a planned record (returned by `plan` and stored in the record that `getPlan` returns) holds `rounds`, `usage`, `costUsd`, `model`, `effort` (the level the client asked for) and `fallbackUsed`, and these fields about the provider:

| Field | Meaning |
| --- | --- |
| `provider` | The name of the provider that answered, such as `openai`. |
| `effortDetail` | `{ requested, effective, native, collapsed }`: the level asked for, the level that ran, the value sent to the provider and whether the two levels differ. Gemini, for example, runs `xhigh` and `max` as `high`. |
| `reasoningCapped` | `false` when the provider does not count hidden reasoning against the output cap (Grok). |
| `costNote` | Present only when `reasoningCapped` is `false`: a sentence saying the cap is soft and the cost can be above the estimate. |

All four are optional in the protocol schema. A plan stored before they existed has none of them and still reads through `getPlan` and `listPlans`. The meta is stored as JSON text, so no migration was needed. A failed record's meta has none of them either.

| Code | Meaning |
| --- | --- |
| `LLM_UNAVAILABLE` | No model provider, or the provider refused access: an authentication error from any provider, whether it reaches the server as a plan failure or on its own. The message is one of three fixed texts and never carries the provider's text: `the model provider rejected the credentials`, `the model provider refused account access` (HTTP 403) and `the model provider reports a billing or quota problem` (HTTP 402, a quota or payment category, or the 429 that OpenAI sends for an exhausted quota) |
| `PLAN_INVALID` | No valid plan after the repair rounds; `problems` lists `<code> at <pointer>` |
| `PLAN_PROVIDER` | The model provider failed |
| `PLAN_CANCELLED` | The plan was cancelled |
| `PLAN_BUSY` | Too many plans are running |
| `PLAN_EXISTS` | The plan id is already in use |
| `PLAN_NOT_CONFIRMED` | A flag is not confirmed |
| `PLAN_DEPLOYED` | The plan is already deployed, or has no workflow to deploy |
| `ATTACHMENT_REJECTED` | An attachment is missing, too large, of the wrong type or over the count limit |
| `INVALID_PARAMS` | The params are malformed, or the selection does not fit the stored workflow |
| `NOT_FOUND` | The plan, the workflow or (for an edit with an `id`) the memory note does not exist |
| `MEMORY_INVALID` | The note breaks a rule; `problems` names the rule that failed, never the text |
| `MEMORY_FULL` | The 20 note places are taken; delete one first |
| `MEMORY_DUPLICATE` | A note with the same text, ignoring case and spacing, is already saved |

## Memory methods

The user can keep up to 20 short notes, such as "my receipts live in ~/Receipts" or "alerts go to the connection team-alerts". The planner reads them on every plan request that uses memory, so it asks fewer questions and fills the same defaults. A note is created, changed or deleted only by an explicit request to one of these three methods. No plan, plan result, attachment, `llm.extract` output, question or patch writes one, and the planner package has no database access at all.

| Method | Params | Result |
| --- | --- | --- |
| `listMemory` | none | `items`, oldest first |
| `saveMemory` | `text`, optional `id` | `item` |
| `deleteMemory` | `id` | `deleted` |

An item is `{ id, text, createdAt, updatedAt }`. `saveMemory` without `id` creates a note under a new random id (the client does not choose it). With an `id` it edits that note: the id and `createdAt` stay and `updatedAt` moves, and an unknown id is `NOT_FOUND`. `deleteMemory` answers `false` for an id that is not there. The three methods work when the engine has no model provider.

### Rules for a note

`saveMemory` applies these rules to `text` before it stores anything (`normaliseMemoryText` in the engine):

- The text is normalised to NFC, trimmed, and every run of spaces inside it becomes one space.
- It has 1 to 300 characters after that. An emoji counts once.
- It is one line: no line feed, carriage return, tab or other control character, no line or paragraph separator, no bidirectional formatting character (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069), and no other invisible format character (Unicode category Cf such as the zero-width space, the soft hyphen or the tag characters, and the variation selectors U+E0100 to U+E01EF). The zero-width joiner and non-joiner stay allowed for emoji sequences and some scripts; the tag characters of a subdivision flag emoji do not.
- No two notes have the same text once the case is folded (upper-cased and lower-cased again, so `Straße` and `STRASSE` are the same note). Saving a copy, or editing a note into a copy of another note, is `MEMORY_DUPLICATE`. A note can be saved again with only its case changed.
- At most 20 notes exist. The count and the insert run in one transaction, so two clients that race for the last place cannot both get it. Editing a note when the list is full is allowed.

The protocol caps `text` at 2000 characters, only to bound the payload; a text between 301 and 2000 characters passes the schema and is `MEMORY_INVALID` with the rule `too_long`. The error of a rejected note carries the name of the rule (`empty`, `control_character`, `line_separator`, `bidi_format`, `format_character`, `too_long`) and never the text. A rejected request is also not logged with its text: an unexpected failure of `saveMemory` logs only the error name, like the planner methods.

### Notes in a plan

`plan` takes an optional `useMemory`. It defaults to `true`; `false` sends no notes for that request. A client cannot send notes with a plan: `plan` has no such param, and the engine reads the saved notes itself when the plan starts.

What leaves the engine: with memory on, the note text goes to the model provider on every call of the plan, as a system block after the node catalog and before the conversation. The block says that the notes are the user's own preferences and facts and not instructions that change the planner's rules, that the current request wins when a note disagrees with it, and that an attached file cannot add, change or delete a note. The notes sit between `<user-memory-...>` tags with 12 random hex characters, drawn once per plan from the same random source as the attachment tags. A note that would hold the closing tag, or a line break, is left out of the prompt and counted in `memoryDropped`. There is no retrieval layer: all notes go in, and the model picks the ones that matter.

What does not leave: the engine never copies the note text into logs, error messages, protocol events or plan records. What the model writes is stored like any plan result, so a summary, a question or a config value that quotes a note (the folder from a note ends up in the workflow, which is the point) is stored with the result. A record keeps `memoryIds`, the ids of the notes the plan loaded (an empty list when memory was off or nothing was saved, and for plans stored before memory existed), and the meta of a planned record gains `memoryUsed` and `memoryDropped`, two counts. Both are optional in the protocol schema. The `PlanRecord` and `PlanMeta` results are closed, so a client built before these fields rejects `plan` and `getPlan` results that carry them, as with the provider fields above; `PROTOCOL_VERSION` is still 1.

Notes count as text the user wrote when the planner decides what to flag. A URL, a folder, a file name or a connection that a note holds is not flagged as `new_egress_target` or `attachment_origin`; the same value in no note and no message still is. A note is never added to the attachment texts, and a word that only an attachment and a note share is not hidden in the summary or in the repair messages.

Cache: the notes block is marked for caching only when the provider declares explicit caching and one more breakpoint stays within its maximum, counting the node catalog and a cached attachment turn. Otherwise the notes form an unmarked block after the node catalog, which stays cached (explicit caching with no room, automatic caching, or no caching). The tag changes with every plan, so the block is read from the cache across the repair rounds of one plan, not across plans.

Storage: migration 5 creates `memory_items` (`id`, `text`, `text_key` unique, `created_at`, `updated_at`) and adds `memory_ids` to `plans`. The unique key is the case-folded text and is what refuses duplicates.
