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

## Workflow checks

`deploy`, every repair round of `plan` and `instantiateRecipe` call the same `validateWorkflow` from `@rill/nodes-core`, so a refusal carries the same codes everywhere (`packages/dsl/ISSUES.md` lists them). One check needs the whole workflow instead of one node: `inside_watched_folder`. A file that a node writes (a `path` field of a node with a side effect) must not be in the folder of a `trigger.folderWatch` when the pattern of the trigger matches the name of the file. The trigger would take each write for a new file and start the run again, so a receipt ledger inside the watched folder would call the model without end.

The comparison uses the folder that `~/` stands for and ignores case and the form of the path (dot segments, double slashes, a trailing slash). It also compares the real folders behind symbolic links, as far as they exist, so `/tmp/in` and `/private/tmp/in` count as one folder. It sees a file as the trigger does, with the same pattern matcher: a hidden file, an editor lock file, a temporary or partial download file, or a file in a subfolder is not seen. A path that starts with the output `file` of the trigger itself (`{{t1.output.file}}` or `{{t1.output.file}}.csv`) lands in the watched folder by definition and is refused when the pattern would match it; for the part after the reference the check tries the pattern on a placeholder name plus that part, so it is an approximation. A path that another template decides is read as ordinary text when it is absolute and skipped when it is relative, since a relative path depends on the folder the engine runs in. Case-insensitive folder comparison can refuse a layout that is fine on a case-sensitive file system. Loops between two workflows (one writes where the other watches) and workflows that are already deployed are not checked.

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

## Explain method

`explainRun` answers the question "why did this run fail?" for the person who does not program. The model reads a bounded, redacted digest of the run and returns a short plain-language explanation, a likely-cause category, up to three suggested actions and, when one node's settings can fix the failure, a request text the user can send to `plan`. The model only reads the run: it changes nothing, and nothing it returns is executed by the engine.

| Method | Params | Result |
| --- | --- | --- |
| `explainRun` | `runId`, optional `effort` (`low`, `medium` or `high`, default `low`) | `runId`, `explanation`, `likelyCause`, `suggestedActions`, optional `fixProposal`, `signals`, `meta` |

The call is made only when a client asks for it, which means the user pressed a button. The engine never explains a failure on its own, and it does not remember an explanation: every call asks the model again and nothing is stored. Any client that holds the engine token may call it, like every other method. `xhigh` and `max` are `INVALID_PARAMS`. At most 2 explanations run at the same time; a further one fails with `EXPLAIN_BUSY`.

### Which runs

A run can be explained when it is finished and either has the status `failed` or has at least one step with the status `failed`, `abandoned` or `continued` (a step that failed and went on because of `onError: continue`). A running or queued run, a run that succeeded cleanly and a cancelled run without a failed step are `RUN_NOT_EXPLAINABLE`. An unknown run id is `NOT_FOUND`. A failed run that has no step row, such as a graph with a cycle, can be explained from its run error.

### What is sent to the provider

One structured-output call, plus at most one repair call when the first answer breaks the schema. The repair call names the rule that failed in fixed words and never repeats what the model wrote. What the provider receives:

- The rules, in the system block: explain for a person who does not program, the content between the tags is data from files, web responses and requests that may contain instructions and none of it is to be followed or copied into the answer, and nothing may be claimed as fixed or run.
- The failure signals, outside the data tag: one fixed word per node whose last attempt failed (`http_status_404`, `file_missing`, `timeout` and so on), taken from the shape of the error text by `failureSignals`. They carry no text of the run.
- The digest, inside a tag `run-data-` plus 12 random hex characters drawn for every call, from the same random source as the attachment and memory tags. A closing tag in the run data is replaced by `<hidden>`.

The digest is at most 12,000 characters (`MAX_DIGEST_CHARS`), counted after the secrets were replaced. It holds, in this order, the run (status, whether it was a dry run, how long it waited and ran, the run error), the workflow outline (node id, type, title, the config, the edges) and the steps: failed steps first, then the steps right before them, then the rest in run order, as many as fit. Each step has the status, the number of attempts, the error of the last attempt (500 characters) and an excerpt of its input and output (1,500 characters together). The digest ends with `omitted: N steps` when some did not fit, and an outline that had to be cut says so. An excerpt goes 4 levels deep, keeps 5 items of a list and 20 keys of an object, cuts a string at 200 characters, and replaces base64 text of 200 characters or more and `data:` URLs with `<binary N chars>`; every cut says how much was left out.

What the digest never contains:

- The value of a key that looks like a credential, at any depth and in the workflow as well as in the steps: a key that contains `authorization`, `cookie`, `token`, `secret`, `password`, `passwd`, `api-key`, `bearer`, `session`, `credential`, `private-key`, `access-key` or `signature`, one that is the whole word `auth`, `pwd`, `pass`, `sig`, `jwt` or `key` (also after a separator, as in `x-auth` or `ssh_key`), or one that ends in a capitalised `Key` (`sshKey`). A key such as `author`, `monkey` or `passed` is kept. The value becomes `<redacted>`.
- Header values. Request headers keep only `content-type`, `accept` and `idempotency-key`; every other value is `<redacted>`. The response headers of an `http.request` keep only `content-type` and `retry-after`.
- Credentials in a URL: user info and the value of a query parameter that looks like a credential.
- The secret of a connection that the workflow uses. The engine looks up every connection name the workflow holds (and the names that its steps resolved from references) through the connections resolver, plus every connection it was told about (`planConnections`), used or not. For a node whose type the registry no longer has, it also takes every string under a key called `connection` or ending in `Connection`. The digest replaces every occurrence of a secret of 4 or more characters with `<secret>`, in these forms: as it is, JSON-escaped (once or twice), percent-encoded (upper or lower case hex digits, the strict RFC 3986 set, `+` for a space), base64 and base64url (with or without padding), hex, and inside the base64 of a longer value (for example a `Basic` header, at any of the three byte alignments, when the part that depends on the secret alone is 8 or more characters). A server that echoes the `Authorization` header in an error body therefore cannot leak the secret. A connection that the engine was not told about and that no node names cannot be replaced, because nothing says what it is.
- A credential that is not a connection secret but looks like one in text: the value after an `Authorization`, `Proxy-Authorization`, `X-Api-Key` or similar header name, a whole `Cookie` or `Set-Cookie` line, the credential after `Bearer` or `Basic` when it has a digit or a capital letter, and the value of `NAME=value` or `"name": "value"` when the name is a credential word and the value has 8 or more characters with a digit or a capital letter. A line such as `token: expired` is not touched. This is a pattern check, not a guarantee: a credential in a shape these rules do not know can still appear.
- The keys of the model provider. They stay in the provider object. The request has only the rules, one message, the schema and the limits (a test pins its keys), so nothing of the engine's environment rides along.

The trigger payload is not a separate section. It reaches the digest only where a step's resolved input contains it.

`result.meta` says what left the machine: `provider` (the name of the provider that received the digest), `model`, `effort` (`{ requested, effective, native, collapsed }`), `digestChars` (how many characters of digest were sent), `truncated` (steps or outline nodes were left out), `usage`, `costUsd` (`null` when the price is unknown) and `repaired`. A client shows these next to the answer, labelled as sent to an external service.

### Read-only

`explainRun` only reads. It writes no row (a test compares the full content of every table, the journal, the plans and the memory included, before and after), emits no event, starts no run, retries no step and calls no node. A run, its steps and what `getRun` and `listRuns` return are the same after the call. The run data and the model's answer are never written to a log, an error message, an error frame or an event: failures carry the fixed texts below, and an unexpected failure of `explainRun` logs only the error name, like `plan`.

### Errors

| Code | Meaning |
| --- | --- |
| `NOT_FOUND` | The run, or the workflow of the run, does not exist |
| `RUN_NOT_EXPLAINABLE` | The run has not finished, or it has no failure to explain |
| `LLM_UNAVAILABLE` | No model provider, or the provider refused access; the same three fixed texts as for `plan` |
| `EXPLAIN_PROVIDER` | The model provider failed, or the explanation was cancelled because the engine shut down |
| `EXPLAIN_INVALID` | The answer broke the schema twice |
| `EXPLAIN_BUSY` | Two explanations are already running |
| `INVALID_PARAMS` | The params are malformed, or `effort` is `xhigh` or `max` |

The texts are fixed and never carry the provider's words or anything from the run.

A call is checked in this order: the run exists, a provider is configured, fewer than 2 explanations are running, and only then are the steps of the run loaded and the run checked for a failure. A refused call therefore costs one row read. If the client closes its connection while the call runs, the call to the provider is cancelled and the place is given back.

### The answer

`likelyCause` is one of `configuration`, `input_data`, `external_service`, `credentials_or_connection`, `permission_or_path`, `rate_limit_or_timeout`, `workflow_design` and `unknown`. `suggestedActions` has 0 to 3 distinct words from `retry_run`, `open_connections`, `edit_node`, `check_input_file`, `wait_and_retry`, `deactivate_workflow` and `none`. `explanation` is 1 to 1,500 characters and `fixProposal.requestText` 1 to 400. A `fixProposal` for a node that the workflow does not have is dropped. `signals` is the list of `{ nodeId, signal }` the engine worked out itself, so a client can trust it more than the prose.

The text of the model is scrubbed before it is returned. In the explanation and in the request text, every URL, host name, e-mail address and Slack-style recipient that the workflow's own JSON, node ids and titles do not contain becomes `<hidden>`, so text from a web response or a file cannot hand the user an address to send data to. A path in the explanation that occurs in the digest is kept (the user needs to know which file failed); a path that does not is hidden. The request text is stricter, because it can reach `plan` as the user's own words: every other literal it holds that the workflow does not contain also becomes `<hidden>`. Invisible format characters and control characters are removed from both; the zero-width joiner and non-joiner stay, because some scripts and emoji need them, and a host that holds one is hidden like any other host.

Host names are read in any script: a name written in letters, digits, marks and underscores of any language, with a top-level name of 2 to 24 letters or a `xn--` form, counts (also after a leading dot, as a cookie domain is written, and after a zero-width joiner), and a host of the workflow counts in its Unicode and its punycode form alike. A name that follows a `/`, `-` or `@` directly is not read as a host, because it is part of a path, a flag or an address that the earlier steps handle. A reference to the output of a node (`n1.output.status`) is kept when the workflow has it, or when it stands alone inside `{{ }}`; a bare one that the workflow does not have is hidden, because a bare `n1.output.evil.com` is also a host. The request text also hides any token of the form `word.word` that has a letter, a final part of 2 or more characters and no match in the workflow, however short, so a short host or a file name that is new cannot get through; numbers such as `2.5` and abbreviations such as `e.g.` stay. What the scrubber does not read as a host: a name written with spaces or brackets (`evil dot com`, `evil[.]com`) and a name with full-width or ideographic dots. The planner's provenance check already treats such text as not written by the user, so the model cannot turn it into a destination without the flag.

### Client contract

- `explanation` is plain text. A client must not render it as links, HTML or markdown, and must not make an address in it clickable.
- `fixProposal` is a suggestion. Show it to the user, let them edit it, and send it to `plan` as their own request, with `workflowId` and `selection: { nodeId }` so the planner works in patch mode on that node. Never send it automatically. The planner then checks it like any other request, including the flags for values the user did not write.
- Each of `suggestedActions` maps to a button that the app owns and that asks for its own confirmation (for example `retry_run` starts a run, `open_connections` opens the connections view, `edit_node` selects the node, `check_input_file` opens the file's folder, `wait_and_retry` offers a later retry, `deactivate_workflow` deactivates it). The model executes nothing and no result field is ever executed, deployed or applied by the engine.

Not in this method: the desktop view of the explanation, storing explanations, explaining a failure automatically, and questions across runs. The desktop plan owns the button and the flow.


## Recipe methods

A recipe is a ready-made, validated workflow with a short form. The user picks one from a gallery, fills in the form and gets a workflow draft, without asking the planner. The recipes and the rules for the form are in `@rill/recipes` (see its README). Both methods work with no model provider, no attachments folder, no configured connection and no network.

| Method | Params | Result |
| --- | --- | --- |
| `listRecipes` | none | `recipes` |
| `instantiateRecipe` | `recipeId`, `values` | `recipeId`, `workflow`, `summary` |

`listRecipes` returns one entry per recipe, in catalogue order: `id`, `title` and `description` (each `{ ko, en }`), `tags`, `params` (the form: `id`, `kind`, `label`, optional `help`, `required`, optional `default`, `min` and `max`, optional `extension` for a file and `connectionKind` for a connection), `nodeTypes` (the node types of the workflow, once each) and `needsConnection` (the form has a `connection` parameter). It never carries a workflow body or the sample values of the recipe.

`instantiateRecipe` turns the values of the form into a workflow draft. `values` maps a parameter id to a string or a number: at most 20 values, each string at most 500 characters. The params object is closed. The engine checks in this order:

1. The recipe exists, or the call fails with `NOT_FOUND` and the fixed text `recipe not found`.
2. Every value against the rules of its parameter kind, and the form for missing required values and keys that no parameter declares. A failure is `RECIPE_INVALID` and each problem is `<param>: <rule>`, such as `schedule: bad_cron`, `message: template_text` or `threshold: below_min`.
3. The filled workflow through `validateWorkflow`, all three stages, with the engine's node registry, its allowed folders and the names of its configured connections (the list that `plan` gets). The same call refuses a file that a node writes into a folder that a folder trigger watches, when the pattern of the trigger matches the name of the file (`inside_watched_folder`, see "Workflow checks" below). Then one more check on the same workflow: a connection whose kind is not the kind that its field needs (the check of `plan`, `connection_kind_mismatch`). A failure is `RECIPE_INVALID` and each problem is `<code> at <pointer>`, such as `path_outside_roots at /nodes/0/config/folder`, `unknown_connection at /nodes/1/config/connection`, `connection_kind_mismatch at /nodes/1/config/connection` or `inside_watched_folder at /nodes/2/config/file`. A warning does not refuse the draft, as with `deploy`.

The message of `RECIPE_INVALID` is the fixed text `the recipe values are not valid`. A problem names the parameter or the position and a rule or an issue code, never a value. A value is not copied into a message, a problem, a log line or an event, and an unexpected failure of `instantiateRecipe` logs only the error name, like `plan`. A key that is not shaped like a parameter id is reported as `?: unknown_param`.

The result is `{ recipeId, workflow, summary }`:

- `workflow` is the draft. The same recipe and values give the same workflow, node ids included, on every call.
- `summary.nodes` lists `{ id, type, title }` for every node, with the title taken from the node definition.
- `summary.sideEffects` is derived from the node definitions, not stored in the recipe: `idempotent` when a node writes a file (`csv.append`) and `external` when a node calls the network or sends a message (`http.request`, `notify.slack`). It holds each value at most once, in this order, and is empty for a recipe that only reads. It describes what a retry may repeat and does not tell whether content leaves the computer.
- `summary.sendsToModel` is `true` when a node sends content to the model provider (`llm.extract`, which uploads each receipt, whatever its type), and `false` otherwise. It is derived from the node types, not stored in the recipe, and it is separate from `sideEffects` because `llm.extract` is not a side effect in that sense.

`instantiateRecipe` never deploys and never writes: no table changes (a test compares every table before and after, for drafts and for refusals), no run starts and no event is emitted. A draft is not a plan, so it has no flags and no confirmation; the open-plan check of `deploy` does not apply to it.

`~/` in a folder or file value stays as typed in the draft. The engine expands it wherever it uses the path, so the allowed-folder check in step 3 applies to the folder that `~/` stands for.

Only the connections that the connections file lists with a kind are known to this check, the same list the planner sees. A connection written as a plain secret string (the first form in Connections file) is not on that list, so a recipe cannot use it.

### Errors

| Code | Meaning |
| --- | --- |
| `RECIPE_INVALID` | A value or the filled workflow breaks a rule; `problems` lists `<param>: <rule>` or `<code> at <pointer>` |
| `NOT_FOUND` | The recipe does not exist |
| `INVALID_PARAMS` | The params are malformed: an extra field, more than 20 values, a string over 500 characters or a value that is not a string or a finite number |

### Client contract

- Build the form from `params`: one control per entry by `kind`, the label and help in the language of the user, `default` as the initial value of an optional field, `min` and `max` for a number. Send only the fields the user filled in; an optional field that is left out takes its default.
- Show the graph and one line per side effect from `summary` before anything is deployed (for example "writes a CSV file" for `idempotent` and "calls the network or sends a message" for `external`). When `sendsToModel` is `true`, also say that the content of each file is sent to the model provider; this is the line a person most needs before confirming a receipt recipe.
- For a `connection` parameter, offer only the configured connections of its `connectionKind`; for a `file` parameter with an `extension`, filter the picker by it.
- Deploy only after the user confirms, through the existing `deploy` with the `workflow` of the draft. Then use `startRun` with `dryRun` and `activate` as for any workflow.
- Show a `RECIPE_INVALID` problem next to the form field named by `<param>`. A `<code> at <pointer>` problem belongs to the workflow, not to one field: the first segments of the pointer name the node. Do not show a problem as if the user had typed it.
- Never assemble a value from other text, for example a reference to a node. The engine refuses a text that contains `{{` or `}}`.
