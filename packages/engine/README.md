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

Nodes can use both forms. The planner is told only about the second form, by name and kind (`slack`, `http`, `webhookSecret`, `google` or `microsoft`), and never receives a secret. A bad kind or a secret that is not a string stops the command with a usage error.

The secret of an `http` connection can also describe how `http.request` signs the call. The secret is then a JSON text with `"rillAuth": 1` and a `type` of `none`, `apiKey`, `bearer` or `basic`:

    { "rillAuth": 1, "type": "apiKey", "in": "query", "name": "api_key", "value": "..." }
    { "rillAuth": 1, "type": "bearer", "token": "..." }
    { "rillAuth": 1, "type": "basic", "username": "...", "password": "..." }

`apiKey` goes into a header or into the query of the URL (an existing parameter or header of that name is replaced), `bearer` and `basic` set `Authorization`, and `none` sends no credential. `auth.header` and `auth.scheme` of the node are ignored for such a secret. Names are 1 to 128 characters of the HTTP token set and never one of the reserved names `Host`, `Content-Length`, `Content-Type`, `Transfer-Encoding`, `Connection`, `Keep-Alive`, `Upgrade`, `Expect`, `TE`, `Trailer`, `Proxy-Connection`, `Cookie`, `Set-Cookie` or `Idempotency-Key`; values are 1 to 2000 characters without control characters or unpaired surrogates; a username has no `:`. A JSON object that has a `rillAuth` key and does not fit this shape fails the node with the fixed text `connection <name> has a malformed auth value`, and the secret is not sent. Any other string keeps its older meaning: it is the bearer token by default, or the value that `auth.scheme` and `auth.header` describe. A leading blank or byte order mark before the `{` does not make a structured secret plain. The node replaces the components of a structured secret that are 4 or more characters long, and the base64 login of `basic`, with `<secret>` in the error text (before it is cut to 200 characters) and in the response it records, in the raw, percent-encoded and JSON-escaped forms; shorter components are not replaced, and the failure explanation hides them like any other connection secret. An API key in a query can still appear in the log of the server that receives the call.

The secret of a `slack` connection is a Slack webhook URL (`https:`, or `http:` for a local test server; it posts to the channel of the webhook) or a bot token connection. A bot token connection is either the plain token text (`xoxb-` followed by 10 to 200 letters, digits or hyphens) or a JSON text with `"rillSlack": 1`, a `token` and an optional default `channel` of 1 to 80 characters without blanks or control characters:

    { "rillSlack": 1, "token": "xoxb-...", "channel": "#alerts" }

`notify.slack` tells the forms apart from the secret and posts through `chat.postMessage` for a bot token. The `channel` of the step wins over the default channel of the connection; when neither exists the step fails with `no Slack channel: set the channel of this step or give the connection a default channel`, and a step that names a `channel` for a webhook connection fails with a message that says the webhook posts to its own channel. Any other secret fails the node with the fixed text `the Slack connection is not a webhook URL or a bot token`, which holds no part of the secret. A refusal from Slack fails the step with `Slack: <code>` (`ratelimited`, `internal_error`, `fatal_error`, `service_unavailable` and `request_timeout` are retried; Slack says that `internal_error` and `fatal_error` can come after the message was posted, so a retry can send it twice, as a retry after an HTTP 5xx can). The token is replaced with `<secret>` in any error text, and the failure explanation hides it like any other connection secret. `http.request` refuses a connection whose secret is a Slack bot token (the JSON form with `rillSlack`, or the plain `xoxb-` token) with `connection <name> is a Slack connection` before it sends anything, so a workflow cannot send the token to an address of its own. The planner is told whether each `slack` connection is a `webhook` or a `bot` (the engine reads it from the secret and passes only that word), and a plan that sets a `channel` for a webhook connection is sent back for repair with the code `channel_on_webhook`.

### Google and Microsoft connections

The secret of a `google` or a `microsoft` connection is an OAuth access token as plain text, 8 to 8192 characters from the bearer-token set (letters, digits and `-._~+/`, with optional trailing `=`). Anything else fails the node with the fixed text `the connection does not hold an access token`, which holds no part of the secret. Only `google.sheets.append` (a `google` connection) and `microsoft.excel.append` (a `microsoft` connection) use these connections. They read the token from the connection each time they run and send it to one fixed host:

| Node | Request | Host |
| --- | --- | --- |
| `google.sheets.append@1` | `POST /v4/spreadsheets/{spreadsheetId}/values/{range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS` with `{ "values": [[...]] }` | `https://sheets.googleapis.com` |
| `microsoft.excel.append@1` | `POST /v1.0/me/drive/root:/{filePath}:/workbook/tables/{table}/rows/add` with `{ "values": [[...]] }` | `https://graph.microsoft.com` |

Each node adds one row of 1 to 50 cells (strings up to 2000 characters, numbers, booleans or `null`). Google gets the cells as typed with `RAW` input, so a text that starts with `=` stays text and is not evaluated. Excel may read such a text as a formula, so the node puts a single quote in front of a text that starts with `=`, `+`, `-`, `@`, a tab or a carriage return (the rule of `csv.append`; plain numbers stay as they are) and sends `null` as an empty text. The spreadsheet id is 20 to 100 characters of `A-Z a-z 0-9 _ -`. The range is a sheet name or an A1 range such as `Sheet1` or `Receipts!A:D`, at most 120 characters of letters, digits, spaces and `_ . - ' ! : $` (no `?`, `#`, `/` or `%`), and defaults to `Sheet1`. The Excel file is a OneDrive path such as `Receipts/ledger.xlsx` (no leading `/`, no `..` or empty segment, no control character and none of `\ : * ? " < > | # %`, at most 400 characters, ending in `.xlsx`) and the table name starts with a letter or `_` and is at most 255 characters. The table must already exist in the workbook. Path parts are URL-encoded one by one.

A failure shows a fixed text and never a word of the answer: `HTTP 400: the data was not accepted`, `HTTP 401: the sign-in is no longer valid, reconnect the account`, `HTTP 403: the account may not change this file`, `HTTP 404: the file, sheet or table was not found` and `HTTP <status>: the request was not accepted` for any other 4xx. A 429, a 5xx and a network error are retried. Neither API has an idempotency key, so a crash right after the request, or a retry after a server error, a timeout or a network error, can make a resumed run add the row twice. A dry run sends nothing and does not need the connection.

A connection of kind `google` or `microsoft` is never sent anywhere else. A plain `http.request` whose `auth.connection` names one fails before any request with `connection <name> is a Google connection` (or `Microsoft`), and a spreadsheet node that names a connection of another kind fails with `connection <name> is a <kind> connection, not a <google|microsoft> connection`. The engine knows the kind from the `kind` of the entry in this file (`kindOf` of the connection resolver). A spreadsheet node refuses an entry that has no kind (a bare string entry) with `connection <name> has no kind, give it the kind <google|microsoft>`, so a token is only ever used with a `kind` and `http.request` can refuse it.

To append a row without the app, put a token into the connections file and run the workflow:

    { "sheets": { "secret": "ya29....", "kind": "google" } }

    {
      "schemaVersion": 1,
      "name": "append a row",
      "nodes": [
        { "id": "t1", "type": "trigger.manual@1", "config": {} },
        { "id": "n1", "type": "google.sheets.append@1", "config": { "connection": "sheets", "spreadsheetId": "<id from the spreadsheet address>", "values": ["2026-11-12", 12.5, "Cafe"] } }
      ],
      "edges": [{ "from": "t1", "to": "n1" }]
    }

    rill-engine run append-row.json --connections connections.json

An access token lives about an hour and the engine does not refresh it, so a headless run needs a fresh token each time. Signing in and refreshing tokens is the job of the desktop app, which gives the running engine each new token over the parent channel below. When a call is refused with a 401 (and only a 401), the node asks the engine to renew the token once and repeats the same call with the new one; see the parent channel below. The two APIs were read from the vendors' documentation. On 2026-11-13 the maintainer appended one row with each through the desktop app; error answers and other account types are untested live, and the Graph workbook API is documented for OneDrive files, so a personal account may behave differently from a work account.

#### The parent channel

When `serve` runs as an Electron utility process, it listens on `process.parentPort`, which only the process that started it can write to, and accepts exactly two message shapes:

    { "type": "connection.set", "name": "google", "kind": "google", "secret": "<access token>" }
    { "type": "connection.remove", "name": "google" }

`name` and `kind` are both `google` or both `microsoft`, `secret` is a string of 1 to 8192 characters, and a message has no other key. Anything else is ignored and counted, and nothing is stored or printed for it. A `connection.set` replaces the secret of that name, so the next node call reads the new token; a node that is running keeps the token it already read. A `connection.remove` makes the next call fail with `unknown connection: <name>`. The connection also appears to the planner by name and kind, and the failure explanation hides its token like the token of any other connection. A name that the connections file or `RILL_CONNECTIONS` gave to an entry of another kind is left alone, and the message is counted as ignored. `RILL_CONNECTIONS` stays the way to give the engine its first tokens at start. Without a parent port (the command line, tests) nothing listens and nothing changes.

The engine writes one message of its own to the parent, and only for the two account names:

    { "type": "connection.renew", "name": "google" }

A spreadsheet node sends it by calling `renew(name)` on its connection resolver after the service answered its call with HTTP 401 (not 403, 429, a server error or a network error), at most once per node execution. Before it asks, `renewedTokenOf` reads the table: when the table already holds an access token that differs from the one that was refused (the app sent it while the call was in flight), the node repeats the call with it and posts nothing. Otherwise the call is repeated only when the renewal gives a different token. The request names no token and carries no other key. It is posted only when the table holds that name as a connection of the account kind; for a plain connection, an entry of another kind, a name that was removed, or without a parent port, `renew` answers `undefined` at once and posts nothing. Callers for the same name share one request. The answer is the next `connection.set` of that name, whose secret `renew` returns, and the table already holds it when `renew` returns. A `connection.remove` of that name, 20 seconds without an answer, or a port that cannot post answers `undefined`. A `connection.set` or `connection.remove` of another name, and a message that was ignored, do not answer. When `renew` gives `undefined`, the same token or a secret that is not shaped like an access token, the node fails with the same text as before (`HTTP 401: the sign-in is no longer valid, reconnect the account`). A 401 means that the service refused the call before it did anything, so repeating an append cannot add a row twice. The dry run never renews. `http.request` does not renew.

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
| `plan` | `planId`, `text`, `turns`, `attachments`, `effort`, optional `workflowId`, `selection`, `useMemory` and `agentId` | `planId`, `result`, `meta` |
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

`deployPlan` deploys the planned workflow only when `confirmed` contains every flag key of the plan and nothing else. Otherwise it fails with `PLAN_NOT_CONFIRMED`, and the message names the unconfirmed flags by node and pointer, never by value. It does not activate the workflow or start a run; use `activate` and `startRun` (with `dryRun`) for that. It emits one `plan.deployed` event `{ workflowId, planId }` after the workflow is stored, and a deploy that fails emits none (see Hook methods).

`deploy` refuses the content of a plan that has flags and has not been deployed yet, with the same error. The comparison ignores the workflow name, key order, the order of the nodes and edges, and an `onError` or `retry` that only spells out the default. It stops accidental deploys, not a client that edits the content first.

### Records and errors

A record has the status `planned`, `failed` or `cancelled`, the effort, the request text, the attachment references, the ids of the memory notes the plan loaded (`memoryIds`), the id of the agent when a saved agent was used (`agentId`, absent for the built-in agent and for plans stored before agents existed), the result and the meta of a planned record, and the confirmed keys once it is deployed. A failed or cancelled record keeps a fixed error text and the redacted repair rounds, never the model's reply. A planned workflow also keeps, in a column that `getPlan` never returns, the user's side of the conversation behind it when that differs from the request text (see The request of a review).

The meta of a planned record (returned by `plan` and stored in the record that `getPlan` returns) holds `rounds`, `usage`, `costUsd`, `model`, `effort` (the level the client asked for) and `fallbackUsed`, and these fields about the provider:

| Field | Meaning |
| --- | --- |
| `provider` | The name of the provider that answered, such as `openai`. |
| `effortDetail` | `{ requested, effective, native, collapsed, cappedByRule }`: the level asked for, the level that ran, the value sent to the provider, whether the two levels differ and whether a `maxPlanEffort` rule lowered the level (see Rules methods). Gemini, for example, runs `xhigh` and `max` as `high`. |
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
| `AGENT_INVALID` | An agent text breaks a rule; `problems` lists `<field>.<rule>: <fixed sentence>`, never the text |
| `AGENT_FULL` | The 12 agent places are taken; delete one first |
| `AGENT_DUPLICATE` | An agent with the same name, ignoring case and invisible characters, is already saved, or the name is one of the built-in agent |
| `AGENT_NOT_FOUND` | A saved agent with this id does not exist (`saveAgent` with an `id`, `setActiveAgent`, and `agentId` on `plan` or `explainRun`) |
| `AGENT_BUILTIN` | The built-in agent `default` cannot be saved over or deleted |

## Workflow checks

`deploy`, every repair round of `plan` and `instantiateRecipe` call the same `validateWorkflow` from `@rill/nodes-core`, so a refusal carries the same codes everywhere (`packages/dsl/ISSUES.md` lists them). When rules exist, the same call gets them as a policy and adds `rule_violation` issues (see Rules methods). One check needs the whole workflow instead of one node: `inside_watched_folder`. A file that a node writes (a `path` field of a node with a side effect) must not be in the folder of a `trigger.folderWatch` when the pattern of the trigger matches the name of the file. The trigger would take each write for a new file and start the run again, so a receipt ledger inside the watched folder would call the model without end.

The comparison uses the folder that `~/` stands for and ignores case and the form of the path (dot segments, double slashes, a trailing slash). It also compares the real folders behind symbolic links, as far as they exist, so `/tmp/in` and `/private/tmp/in` count as one folder. It sees a file as the trigger does, with the same pattern matcher: a hidden file, an editor lock file, a temporary or partial download file, or a file in a subfolder is not seen. A path that starts with the output `file` of the trigger itself (`{{t1.output.file}}` or `{{t1.output.file}}.csv`) lands in the watched folder by definition and is refused when the pattern would match it; for the part after the reference the check tries the pattern on a placeholder name plus that part, so it is an approximation. A path that another template decides is read as ordinary text when it is absolute and skipped when it is relative, since a relative path depends on the folder the engine runs in. Case-insensitive folder comparison can refuse a layout that is fine on a case-sensitive file system. Loops between two workflows (one writes where the other watches) and workflows that are already deployed are not checked.

## Deleting a workflow

`deleteWorkflow` takes `{ workflowId }` and answers `{}`. It is additive: `PROTOCOL_VERSION` stays 1.

The engine checks in this order and stops at the first failure, so a refusal changes nothing:

1. An unknown id is `NOT_FOUND`.
2. A workflow with a run that is `queued` or `running` is `WORKFLOW_BUSY`. The client has to stop or wait for the run first, and the workflow stays active.
3. The triggers of the workflow are stopped (the same as `deactivate`) when it is active or still activating. Only then a `workflow.deactivated` event comes first; an inactive workflow emits no such event.
4. One transaction deletes the rows below, and the call then emits one `workflow.deleted` event with the `workflowId`. If the transaction fails, nothing is deleted and no `workflow.deleted` event is emitted; the workflow is then stopped but still stored.

| Table | What happens |
| --- | --- |
| `step_attempts` | Rows of the runs of the workflow are deleted. |
| `idempotency_journal` | Rows whose key is the idempotency key of one of those step attempts are deleted. Keys of other workflows stay. |
| `runs` | Deleted. |
| `trigger_state` | Deleted. |
| `seen_files` | Deleted, so a workflow deployed again for the same folder starts fresh. |
| `workflows` | The row is deleted. |
| `plans` | Kept. Only `workflow_id` is set to null, because it points at a workflow that is gone. `confirmed` stays: it records which flags the user approved, not a link. The request text, the result and the meta of a plan are the user's own history and do not need the workflow row, and a plan can be deployed again with `deployPlan`, which writes `workflow_id` and `confirmed` anew. |
| `memory_items` | Untouched. A note has no link to a workflow. |
| `agents`, `app_state` | Untouched. An agent has no link to a workflow, and a plan keeps the `agent_id` it was made with. |
| `hooks` | Rows whose scope is the workflow are deleted. A hook with the scope all stays. |
| `hook_log` | Kept. A row has no link to a hook or a workflow, so the screen can call it a deleted hook. |

Other windows learn of the delete through the `workflow.deleted` event.

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

## Rules methods

The user can set rules for the whole app. A rule only restricts: it can forbid a node type, narrow the hosts that `http.request` may call, or cap the planning effort. The engine stores the rules and enforces them in the shared validator, at deploy, activation, run start and trigger firing, and in the planner. A client only edits the list and shows the result. Nothing the model, an attachment, a recipe, an imported workflow or a run produces can create, change or delete a rule: the only write paths are `saveRule` and `deleteRule`. There is at most one rule of the kind `maxPlanEffort`, and at most 30 rules in all.

| Method | Params | Result |
| --- | --- | --- |
| `listRules` | none | `rules`, oldest first |
| `saveRule` | `kind`, `value` | `rule` |
| `deleteRule` | `id` | `deleted` (always `true`; an unknown id is `RULE_NOT_FOUND`) |
| `checkRules` | none | `violations` |

A rule is `{ id, kind, value, createdAt }`. The four methods work when the engine has no model provider. `PROTOCOL_VERSION` is still 1.

### Kinds and values

`saveRule` trims the value, composes it to NFC and refuses control characters, line and paragraph separators, bidirectional formatting characters and invisible format characters, as `saveMemory` does. The value is not copied into an error. The stored value is the normalised one, so two spellings of one rule are one rule (`RULE_DUPLICATE`).

| Kind | Value | Effect |
| --- | --- | --- |
| `forbidNode` | A node type of the catalog without its version, such as `http.request`. Case is ignored and the catalog spelling is stored (`trigger.folderWatch`). | No workflow may contain a node of this type, in any version. Triggers and the spreadsheet nodes can be forbidden too. |
| `allowHost` | A host name (`api.example.com`), a wildcard (`*.example.com`) or an address (`127.0.0.1`, `[::1]`; a bare IPv6 address is stored in brackets). An internationalised name is stored as punycode. | With no `allowHost` rule every host is allowed. With one or more, `http.request` may only call a host that matches one of them. |
| `maxPlanEffort` | One of `low`, `medium`, `high`, `xhigh`, `max`. | `plan` requests above the cap run at the cap. Saving it again replaces the rule and keeps its id; saving the same value again is not an error. |

A host value has no scheme, path, query, fragment, port, user info or space, no empty part between dots, no leading or trailing dot, labels of at most 63 characters and at most 253 characters in all. A wildcard is `*.` followed by a host name: it matches `a.example.com` and `a.b.example.com` and not `example.com`, so the apex needs its own rule. A wildcard is not allowed in front of an address, and an address is written in full (`127.1` and `0x7f.1` are refused).

### Errors

| Code | Meaning |
| --- | --- |
| `RULE_INVALID` | The value breaks a rule; `problems` names the rule that failed (`empty`, `control_character`, `line_separator`, `bidi_format`, `format_character`, `too_long`, `unknown_node_type`, `unknown_effort`, `host_scheme`, `host_path`, `host_port`, `host_user_info`, `host_space`, `host_empty_label`, `host_wildcard`, `host_characters`, `host_label_length`, `host_too_long`, `host_idn`) and never the value |
| `RULE_FULL` | The 30 places are taken; delete one first |
| `RULE_DUPLICATE` | The same kind and value are already saved |
| `RULE_NOT_FOUND` | `deleteRule` got an id that is not there |
| `RULE_VIOLATION` | `startRun` refused a workflow that breaks a rule; `problems` lists `rule_violation at <pointer>` and no run was created |
| `INVALID_WORKFLOW` | `deploy` or `deployPlan` refused a workflow; the issues include `rule_violation` (`deploy` lists the messages, `deployPlan` lists `<code> at <pointer>`) |
| `RECIPE_INVALID` | `instantiateRecipe` produced a workflow that breaks a rule; a problem is `rule_violation at <pointer>` |
| `ACTIVATION_FAILED` | `activate` refused a stored workflow that now breaks a rule; the message is `the workflow breaks a rule you set; remove the rule or change the workflow` |

An unexpected failure of `saveRule` or `deleteRule` logs only the error name. Rule values never appear in a log line, an error message or an event.

### How a host is judged

The URL is parsed with `new URL`, and the check uses the host of the parsed URL, never a text search. The same parser reads the URL when the request is made, so the host that is checked is the host that is called. A URL with `https://allowed.com@evil.com/`, `https://allowed.com.evil.com/`, `https://evil.com/?h=allowed.com`, a percent-encoded dot, an ideographic full stop or a backslash is judged by its real host. Upper case, one trailing dot, an explicit port, a fragment and user info do not change the host. An internationalised name and its punycode form are the same host. An address matches only a rule that is exactly that address, whatever way the URL spells it (`2130706433` and `127.0.0.1` are one address). Anything the check cannot decide is refused: a URL that does not parse, a scheme other than `http` and `https`, a host with an empty part and a port out of range.

The rule matches names, not addresses. A name that an allowed rule matches can still resolve to a private address, and a redirect is not followed, so only the first URL of a call is checked.

### Where rules are enforced

| Point | What happens when the workflow breaks a rule |
| --- | --- |
| `deploy`, `deployPlan`, `instantiateRecipe` | The shared validator returns `rule_violation` issues and the call is refused. Nothing is stored. |
| `plan` | The planner validates every answer with the rules, so its repair loop gets the `rule_violation` issues and corrects its own plan, or fails with `PLAN_INVALID` after the repair rounds. Patch mode validates the patched workflow the same way. |
| `activate` | The stored workflow is checked again. A rule saved after the workflow was deployed blocks activation. When the engine resumes active workflows at start, one that now breaks a rule is not started and a `trigger.error` event says so. |
| `startRun` | Refused with `RULE_VIOLATION`, no run is created. A dry run is refused too. |
| A run waits in the queue | When the run begins, the rules are read once and the whole workflow is checked. A run that now breaks a rule fails with the fixed text `the workflow breaks a rule you set; remove the rule or change the workflow` before any node runs, and the engine emits one `run.blocked` event `{ workflowId, codes }` and `run.finished`. This holds for a manual run, a run that a trigger queued, and a run that `recover` finds with the status `queued`. |
| A trigger fires | No run starts. The engine emits one `run.blocked` event `{ workflowId, codes }` for that firing, and no `trigger.fired` or `trigger.error`. A webhook call answers 403 `blocked by a rule`. A folder trigger gives up on that file until the workflow is activated again. The file is not recorded as seen, so it is processed after the rule is removed and the workflow is activated again. |
| `http.request` at run time | The final URL, after templates and the query credential of a connection, is checked against the host rules. A host that is not allowed fails the node with the fixed text `this host is not in the allowed hosts` before any request. The text has no URL in it. A dry run makes no request and no check. |

The validator treats `http.request` URLs like this when `allowHost` rules exist: a literal URL is judged by its host; a URL that has a template reference in its scheme, user info, host or port is refused, because the host is only known at run time (the validator puts a placeholder where each reference is and lets `new URL` split the URL, so extra slashes or a backslash after `https:` do not hide a host reference); a reference in the path or the query is fine; a URL that is not an absolute `http` or `https` URL is refused. `notify.slack` posts to `slack.com` or to the webhook of its connection and is not subject to `allowHost` (`forbidNode` can still forbid it). `google.sheets.append` and `microsoft.excel.append` call fixed hosts and are not subject to it either.

### Runs already running

A run takes one snapshot of the rules when it begins to execute. A run that has not started yet (status `queued`, whether it waited behind other runs or was found by `recover` after a crash) is checked against the whole snapshot, forbidden nodes and hosts, and fails with a fixed text before any node runs when its workflow now breaks a rule. `http.request` then uses the host rules of that snapshot. A rule saved while a run is in flight never cuts it. A run resumed after a crash (status `running`) takes a fresh snapshot at the moment it resumes and is not checked against `forbidNode` rules again, because it started legitimately; only the host rules reach the nodes. Deleting a rule needs no re-check.

### checkRules

`checkRules` validates every stored workflow with the current rules and returns `violations`: `{ workflowId, name, issues }` for each workflow that breaks one, oldest first. It reports `rule_violation` issues only, at most 20 per workflow, and at most 200 workflows: all stored workflows are checked and the first 200 that break a rule are returned. An empty list means that no workflow breaks a rule, and also that there is no rule. Workflow names are user text.

### The planner

When a node or host rule exists, the user message lists them after the environment: `Rules set by the user, enforced by validation:` followed by one line for the forbidden node types and one for the allowed hosts. Without a rule the message is byte-identical to what it was before rules existed (a test compares seven recorded conversations with the frozen copy). The system blocks never change.

A `maxPlanEffort` rule lowers the effort of a `plan` request that is above it to the cap. The request is never refused. The record keeps the effort the client asked for; the meta says what ran: `effortDetail.cappedByRule` is `true` when the cap lowered the level, and `collapsed` is `true` whenever the level that ran differs from the one asked for, for either cause. `effortDetail` is `{ requested, effective, native, collapsed, cappedByRule }`, and a record stored before rules existed reads with `cappedByRule: false`. The effort of `explainRun` is not capped.

### Storage

Migration 6 creates `rules` (`id`, `kind`, `value`, `created_at`, `UNIQUE (kind, value)`) and a unique partial index that allows one `maxPlanEffort` row. A database from before this migration migrates forward and keeps its data.

## Agent methods

An agent is a name with a persona and instructions that the user writes. The user picks the active one in the chat, and the planner and the failure explanation follow it. An agent is created, changed, deleted or made active only by an explicit request to one of these four methods. No plan, plan result, attachment, run data, imported file or model answer does it, and the planner package has no database access at all. An agent also has a kind and can carry skills: see Kind and skills of an agent and Skill methods. A reviewer agent is not an agent to chat with; it gives a second opinion on a plan (see Review method).

| Method | Params | Result |
| --- | --- | --- |
| `listAgents` | none | `agents`, the built-in agent first and then the saved agents by name, and `activeId` |
| `saveAgent` | `name`, `description`, `persona`, `instructions`, optional `id`, optional `kind`, optional `skillIds` | `agent` |
| `deleteAgent` | `id` | `deleted` |
| `setActiveAgent` | `id` | nothing |

An agent is `{ id, name, description, persona, instructions, kind, skillIds, builtin, createdAt, updatedAt }`. `saveAgent` without `id` creates an agent under a new random id (the client does not choose it). With an `id` it edits that agent: the id and `createdAt` stay and `updatedAt` moves, and an unknown id is `AGENT_NOT_FOUND`. `deleteAgent` answers `false` for an id that is not there. The four methods work when the engine has no model provider.

The built-in agent has the id `default`. It is not stored: it is always the first entry of `listAgents` with `builtin: true`, an empty persona and empty instructions and both timestamps 0. It cannot be saved over or deleted (`AGENT_BUILTIN`), and `setActiveAgent` accepts it. An app shows its own translated name and description for it, never the text of the engine.

The active agent is one row in the table `app_state` (key `active_agent`), and no row means `default`. `setActiveAgent` with an unknown id is `AGENT_NOT_FOUND`. Deleting the active agent makes `default` active again in the same transaction. A stored id that points at an agent that is not there reads as `default`. The engine itself never reads the active agent for a request: the client sends `agentId` with `plan` and `explainRun`, and an absent `agentId` means `default`, whatever the active agent is. An unknown `agentId` is `AGENT_NOT_FOUND`, answered before the model is called, before a plan record is written and before a plan id is used.

### Rules for an agent

`saveAgent` applies these rules before it stores anything (`normaliseAgentFields` in `@rill/protocol`, the same function the app uses for its hints):

- Every field is normalised to NFC and trimmed. In the name and the description every run of spaces inside the text becomes one space. In the persona and the instructions the inner text is kept as it is.
- The name has 1 to 60 characters, is one line and shows at least one character: a name made only of invisible characters, combining marks, spaces or fillers (the zero-width joiner, the Hangul filler, the braille blank and the like) is `empty`. The description has 0 to 200 characters and is one line. The persona has 0 to 600 characters and the instructions 0 to 3000, and both may hold line feeds. Characters are counted as code points, so an emoji counts once.
- No control character (a carriage return and a tab included; in the persona and the instructions only the line feed is allowed), no line or paragraph separator, no bidirectional formatting character, no invisible format character and no lone surrogate. These are the classes of a memory note; the zero-width joiner and non-joiner stay allowed.
- No two agents have the same name once the case is folded and the invisible characters (the zero-width joiner and non-joiner, variation selectors, the soft hyphen and other default-ignorable characters) are left out of the comparison: `Straße` and `STRASSE` are the same name, and so are `Work` and `Wo` + a zero-width joiner + `rk`. The built-in agent reserves its names, `Default` and its Korean label `기본`, by the same comparison (`AGENT_DUPLICATE`), so the picker never shows two entries with the label of the Default entry.
- At most 12 agents are saved. The count and the insert run in one transaction. Editing an agent when the list is full is allowed, and a duplicate name is reported before a full list.

The protocol caps each text at four times its limit (240, 800, 2400 and 12000 characters), only to bound the payload. The error of a rejected agent carries `<field>.<rule>` for every field that fails (the rule is one of `empty`, `control_character`, `line_separator`, `bidi_format`, `format_character`, `too_long`) and never the text. The agent text is user text like a note: it is not logged, not copied into an error, an event or a plan record, and an unexpected failure of `saveAgent` logs only the error name.

### Kind and skills of an agent

An agent has a kind, `assistant` or `reviewer`, and a list of skill ids. `saveAgent` takes both as optional params. A new agent without them is an assistant with no skills. An edit that leaves one out keeps what is stored, so a client that does not know about skills cannot drop them by saving an agent; an edit that sends `kind` or `skillIds` replaces the stored value, and `skillIds: []` clears the list. The built-in agent is an assistant with no skills, and `saveAgent` with its id is still `AGENT_BUILTIN`, whatever else the params say. `kind` and `skillIds` are optional in the protocol schema of an agent, and this engine always sends both.

Where an agent can be used depends on its kind. Only an assistant can be the active agent, appear in a chat picker, or be named by `plan` and `explainRun`. A reviewer is named only by `reviewPlan` (see Review method). `setActiveAgent` with a reviewer, `plan` or `explainRun` with a reviewer's `agentId`, and a `saveAgent` that would turn the active agent into a reviewer are `AGENT_NOT_ASSISTANT`: the user makes another agent active first. For `plan` and `explainRun` the check sits where the `AGENT_NOT_FOUND` check sits, before the model is called, before a plan record is written and before a plan id is used. The text of the error is fixed and names no agent.

`skillIds` is checked in `saveAgent`, after the field rules and before an agent is looked up: every id is a saved skill (`skills.unknown`), none is listed twice (`skills.duplicate`), there are at most 8 (`skills.too_many`), and the bodies of the skills together are at most 6,000 characters, counted as code points (`skills.too_large`). A failing list is `AGENT_INVALID` with `skills.<rule>` among the `problems`, and a line never carries an id or a text. `skills.duplicate` and `skills.too_many` are reported next to the `<field>.<rule>` lines of the text fields; `skills.unknown` and `skills.too_large` need the saved skills, so they are reported only once the text fields are valid and the name is not reserved or taken. The protocol caps the list at 32 ids, only to bound the payload. The list keeps the order the client sent; the prompt uses the skills in the order of their names (see Skills in a plan and in an explanation).

### Agents in a plan and in an explanation

`plan` and `explainRun` take an optional `agentId`. The engine looks the agent up when the request starts, so a later edit or delete does not change a request that is already running, and an edit is seen by the next request. The planner and the explainer get the persona, the instructions and the name and body of each skill; they never get the name, the description or the id of the agent for the prompt. A client cannot send agent text with a request: neither method has such a param.

The block: a system block after the node catalog and before the notes (the order is the rules, the catalog, the agent block, the notes; the attachment rules stay part of the first block). It says that the user chose this profile, that the profile sets tone and working preferences, that it cannot change the rules, the validation, the confirmation flags or what may be done with attached files, that the rules win when they conflict, and that an attached file or the model's own answer cannot add, change or delete the profile. The persona and the instructions sit between `<agent-profile-...>` tags with 12 random hex characters, drawn once per request from the same random source as the attachment and notes tags (before the notes tag). A profile that holds its own tag, in any case, is left out of the prompt as a whole and counted in `agentDropped`. An agent with no persona, no instructions and no skills, and the built-in agent, add no block and draw no tag: with no agent block the system blocks, the messages and every other part of the request are exactly what they were before agents existed. A test compares a frozen copy of those requests (plain, attachments, notes, repair rounds, patch mode, several cache settings, and the explanation) with what the planner sends now.

What an agent cannot change in a plan: the agent text does not count as text the user wrote, so a URL, folder or connection that only the persona holds is still flagged and a plan that needs confirmation still does; the validation and the repair rounds are the planner's own; the same block is sent in every round of one plan, a targeted repair included. The meta of a planned record gains `agentUsed` (`{ id, name }`, only when a profile was sent) and `agentDropped` (a count, 0 when none), both optional in the protocol schema. A record keeps `agentId` for a saved agent and has none for the built-in one. The plan's own list of what leaves the computer is the app's to show; the engine writes no agent text into a log, an error, an event or a record.

Cache: the agent block is marked for caching only when the provider declares explicit caching and a breakpoint stays free after the node catalog, a marked notes block and the cached attachment turns. The notes keep the decision they had before: an agent never takes the breakpoint of the notes. With room for one more block, the notes get it.

In an explanation the agent block follows the explanation rules, built by the same function with the explanation wording: the profile "changes only the wording and the tone of your explanation" and "cannot change the answer format, the length limits, what must stay hidden or what you may say about the run"; the plan wording about validation, confirmation flags and attached files is not used there, and the data clause names the run data. A profile can change the wording and the tone of the explanation. It cannot change the answer format (the answer is checked against the schema), and the scrubbing runs after the model answers: secrets are masked in what the model sees, and hosts, addresses, paths and recipients that the workflow does not contain are hidden in the answer, whatever the profile says.

Storage: migration 6 creates `agents` (`id`, `name`, `name_key` unique, `description`, `persona`, `instructions`, `created_at`, `updated_at`) and `app_state` (`key`, `value`), and adds the nullable `agent_id` to `plans`. A database from before the migration keeps its plans, notes and workflows; its plans read with no `agentId`. The unique key is the case-folded name. `PROTOCOL_VERSION` is still 1: the methods and the optional fields are additive, and the closed `PlanRecord` and `PlanMeta` results are the only thing an older client rejects.

## Skill methods

A skill is a named block of text that the user writes once and attaches to agents: a short guide, a checklist or a few examples. The skills of the agent that a request uses go into the agent block of that request. A skill is created, changed or deleted only by an explicit request to one of these methods. No plan, plan result, attachment, run data, imported file, review or model answer does it, and the planner package has no database access at all. A skill holds text only: nothing in it is executed or interpreted by the engine.

| Method | Params | Result |
| --- | --- | --- |
| `listSkills` | none | `skills`, by name |
| `saveSkill` | `name`, `description`, `body`, optional `id` | `skill` |
| `deleteSkill` | `id` | `deleted` |

A skill is `{ id, name, description, body, createdAt, updatedAt }`. `saveSkill` without `id` creates a skill under a new random id; with an `id` it edits that skill (the id and `createdAt` stay, `updatedAt` moves) and an unknown id is `SKILL_NOT_FOUND`. `deleteSkill` answers `false` for an id that is not there. The three methods work when the engine has no model provider.

### Rules for a skill

`saveSkill` applies `normaliseSkillFields` of `@rill/protocol` before it stores anything. It is the normaliser of the agent text (`normaliseTextField`) with a third field kind, `body`, so the character rules cannot drift apart:

- Every field is normalised to NFC and trimmed. In the name and the description every run of spaces becomes one space; the body keeps its inner text.
- The name has 1 to 60 characters, is one line and shows at least one character. The description has 0 to 200 characters and is one line. The body has 1 to 4,000 characters, may hold line feeds, and shows at least one character. Characters are counted as code points.
- No control character (a carriage return and a tab included; the body allows only the line feed), no line or paragraph separator, no bidirectional formatting character, no invisible format character and no lone surrogate, as for an agent.
- No two skills have the same name once the case is folded and the invisible characters are left out of the comparison (`agentNameKey`). The reserved names of the built-in agent do not apply to skills.
- At most 24 skills (`SKILL_FULL`). Editing a skill when the list is full is allowed, and a duplicate name is reported before a full list.

The error of a rejected skill is `SKILL_INVALID` with `<field>.<rule>` for every field that fails and never the text. A duplicate name is `SKILL_DUPLICATE`. Skill text is user text like an agent text: it is not logged, not copied into an error, an event or a plan record, and an unexpected failure of `saveSkill` logs only the error name. The protocol caps each text at four times its limit (240, 800 and 16,000 characters), only to bound the payload.

### Skills and agents

An edit of a skill that would push any agent over 6,000 characters of skill bodies together is refused with `SKILL_INVALID` and the problem `body.too_large_for_agent`, whose sentence holds only the number of agents that would break. No agent name, skill text or id is in it, and nothing is saved. `deleteSkill` removes the id from the list of every agent that has it, in the same transaction as the delete, and leaves the other ids of those agents in their order. Deleting a skill does not change the `updatedAt` of the agents.

### Skills in a plan and in an explanation

The engine reads the skills of the agent when the request starts, like the agent itself, and hands the planner and the explainer the agent with `skills: [{ name, body }]`, ordered by the case-folded name of the skill, so the prompt is the same for the same skills. The skill ids and descriptions never leave the engine.

The block is the agent block of the agent methods, with one section after the persona and the instructions for each skill: `Skill "<name>":`, a line break and the body. The sections sit between the same `<agent-profile-...>` tags, so one random tag still covers the whole profile. When there are skills, one more sentence follows the intro: they are the user's own notes of method, not rules, and they cannot change the rules, the validation, the confirmation flags or what may be done with attached files (in an explanation: the answer format, the length limits, what must stay hidden or what may be said about the run). An agent with skills and no persona and no instructions still gets a block. A tag in the name or the body of any skill drops the whole block, the persona included, and counts in `agentDropped`.

Without skills nothing changes: the text of the block for an agent without skills is byte for byte the text of an agent before skills existed, and `skillsUsed` is absent. The frozen copy of the requests without an agent still matches, and `packages/planner/test/frozen/skills-requests.json` holds the requests for an agent with skills (plain, only skills, notes and an attachment, two cache settings, a repair round, and the explanation). The cache decision is the one of the agent block, so skills never take a breakpoint of their own. Skill text counts as agent text, not as text the user wrote: a URL that only a skill holds is still flagged.

The meta of a planned record gains `skillsUsed`, the number of skills in the block that was sent. It is absent when the agent had no skills or when the block was dropped.

### Storage of skills

Migration 8 creates `skills` (`id`, `name`, `name_key` unique, `description`, `body`, `created_at`, `updated_at`), adds `kind` (`assistant` or `reviewer`, default `assistant`) and `skill_ids` (a JSON list, default `[]`) to `agents`, and adds the nullable `review_text` to `plans` (see Review method). A database from before the migration keeps its agents as assistants without skills and its plans without a `review_text`. `PROTOCOL_VERSION` is still 1: the methods, the params and the fields are additive. As in the agent section, the closed results are the one thing an older client rejects: an `Agent` now carries `kind` and `skillIds`, and a plan meta can carry `skillsUsed`, so a client built before skills fails its own check of `listAgents`, `saveAgent` and such a plan record. The app and the engine ship together.

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
| `AGENT_NOT_FOUND` | The `agentId` names an agent that does not exist |
| `AGENT_NOT_ASSISTANT` | The `agentId` names a reviewer agent |
| `EXPLAIN_BUSY` | Two explanations are already running |
| `INVALID_PARAMS` | The params are malformed, or `effort` is `xhigh` or `max` |

The texts are fixed and never carry the provider's words or anything from the run.

A call is checked in this order: the run exists, a provider is configured, the agent exists and is not a reviewer, fewer than 2 explanations are running, and only then are the steps of the run loaded and the run checked for a failure. A refused call therefore costs one row read. If the client closes its connection while the call runs, the call to the provider is cancelled and the place is given back.

### The answer

`likelyCause` is one of `configuration`, `input_data`, `external_service`, `credentials_or_connection`, `permission_or_path`, `rate_limit_or_timeout`, `workflow_design` and `unknown`. `suggestedActions` has 0 to 3 distinct words from `retry_run`, `open_connections`, `edit_node`, `check_input_file`, `wait_and_retry`, `deactivate_workflow` and `none`. `explanation` is 1 to 1,500 characters and `fixProposal.requestText` 1 to 400. A `fixProposal` for a node that the workflow does not have is dropped. `signals` is the list of `{ nodeId, signal }` the engine worked out itself, so a client can trust it more than the prose.

The text of the model is scrubbed before it is returned. In the explanation and in the request text, every URL, host name, IPv4 or bracketed IPv6 address, e-mail address and Slack-style recipient that the workflow's own JSON, node ids and titles do not contain becomes `<hidden>`, so text from a web response or a file cannot hand the user an address to send data to. A path in the explanation that occurs in the digest is kept (the user needs to know which file failed); a path that does not is hidden (a path starts with `/`, `~/`, a drive letter or `\\server\share`). The request text is stricter, because it can reach `plan` as the user's own words: every other literal it holds that the workflow does not contain also becomes `<hidden>`. Invisible format characters and control characters are removed from both; the zero-width joiner and non-joiner stay, because some scripts and emoji need them, and a host that holds one is hidden like any other host.

Host names are read in any script: a name written in letters, digits, marks and underscores of any language, with a top-level name of 2 to 24 letters or a `xn--` form, counts (also after a leading dot, as a cookie domain is written, and after a zero-width joiner), and a host of the workflow counts in its Unicode and its punycode form alike. A name that follows a `/`, `-` or `@` directly is not read as a host, because it is part of a path, a flag or an address that the earlier steps handle. A reference to the output of a node (`n1.output.status`) is kept when the workflow has it, or when it stands alone inside `{{ }}`; a bare one that the workflow does not have is hidden, because a bare `n1.output.evil.com` is also a host. The request text also hides any token of the form `word.word` that has a letter, a final part of 2 or more characters and no match in the workflow, however short, so a short host or a file name that is new cannot get through; numbers such as `2.5` and abbreviations such as `e.g.` stay. What the scrubber does not read as a host: a name written with spaces or brackets (`evil dot com`, `evil[.]com`) and a name with full-width or ideographic dots. The planner's provenance check already treats such text as not written by the user, so the model cannot turn it into a destination without the flag.

### Client contract

- `explanation` is plain text. A client must not render it as links, HTML or markdown, and must not make an address in it clickable.
- `fixProposal` is a suggestion. Show it to the user, let them edit it, and send it to `plan` as their own request, with `workflowId` and `selection: { nodeId }` so the planner works in patch mode on that node. Never send it automatically. The planner then checks it like any other request, including the flags for values the user did not write.
- Each of `suggestedActions` maps to a button that the app owns and that asks for its own confirmation (for example `retry_run` starts a run, `open_connections` opens the connections view, `edit_node` selects the node, `check_input_file` opens the file's folder, `wait_and_retry` offers a later retry, `deactivate_workflow` deactivates it). The model executes nothing and no result field is ever executed, deployed or applied by the engine.

Not in this method: the desktop view of the explanation, storing explanations, explaining a failure automatically, and questions across runs. The desktop plan owns the button and the flow.

## Review method

`reviewPlan` gives a second opinion on a plan that the planner made. A reviewer agent, which the user wrote like any agent and gave the kind `reviewer`, reads the plan and returns advice: a short summary and a list of findings with a severity. The review is advice only. It does not change the plan, the workflow, an agent, a skill, a rule or a hook, it does not start a run, it does not touch the flags, the confirmation or the deploy state, and it is not stored. It costs one extra model call, and only a client call starts it.

| Method | Params | Result |
| --- | --- | --- |
| `reviewPlan` | `planId`, `agentId`, optional `effort` (`low`, `medium` or `high`, default `medium`) | `review` (`summary` and `findings`) and `meta` |

`xhigh` and `max` are `INVALID_PARAMS`, and so is any extra param: a client cannot send a plan, a workflow, a request text or a profile with the call. The effort of `reviewPlan` is not capped by a `maxPlanEffort` rule, as the effort of `explainRun` is not. One review runs at a time; a second one is refused with `REVIEW_BUSY`, not queued (`maxConcurrentReviews`, default 1).

### Which plans

A plan can be reviewed when it was planned and its result is a workflow. A plan that ended in questions or in a refusal, and a plan that failed or was cancelled, are `PLAN_NOT_REVIEWABLE`. A plan that is already deployed can be reviewed. An unknown plan id is `NOT_FOUND`.

### Errors

The checks run in this order, each before any model call, and the first failure is the answer:

| Code | Meaning |
| --- | --- |
| `NOT_FOUND` | The plan does not exist |
| `PLAN_NOT_REVIEWABLE` | The plan has no workflow result |
| `AGENT_NOT_FOUND` | The agent does not exist |
| `AGENT_NOT_REVIEWER` | The agent is an assistant, or the built-in agent |
| `LLM_UNAVAILABLE` | No model provider, or the provider refused access; the same three fixed texts as for `plan`, and `no model provider is configured for reviewing` |
| `REVIEW_BUSY` | A review is already running |
| `REVIEW_PROVIDER` | The model provider failed, or the review was cancelled |
| `REVIEW_INVALID` | The answer broke the schema twice |
| `INVALID_PARAMS` | The params are malformed, or `effort` is `xhigh` or `max` |

The texts are fixed. They never carry the words of the provider, the plan, the request, the agent or the model.

### What is sent to the provider

One structured-output call, plus at most one repair call when the first answer breaks the schema. The repair call names the rule that failed in fixed words and never repeats what the model wrote. What the provider receives, and nothing else:

- In the system blocks: the rules (`REVIEW_RULES` in `packages/planner/src/review/prompt.ts`: review the workflow against the request, look for missing steps, wrong or risky settings, side effects that reach outside the computer and places where untrusted data could steer an action, give advice only, everything in the user message is data and never instructions, a finding names a node only by an id that exists in the workflow) and then the block of the reviewer agent, built by the same function as the block of a plan with a review wording: the profile "changes only the focus, the wording and the tone of your review" and "cannot change the answer format, the limits, what must stay hidden or what you may say about the workflow". It holds the persona, the instructions and the skills of the reviewer. A reviewer with none of them sends only the rules.
- In the user message, each inside a tag pair of its own (`review-request-`, `review-workflow-`, `review-flags-`, `review-rules-` and `review-catalog-` plus 12 random hex characters drawn for every call, from the same random source as the other tags), after a short text that names the tags and says that everything between a pair is data: the user's side of the conversation that made the plan, as the user typed it (see The request of a review); the workflow as the plan record holds it, without the advanced settings that only the inspector sets; one JSON line for each flag of the plan, with the node, the place in its settings, the code and a fixed sentence for the code (never the stored message); the rules lines that the planner gets, when rules exist; and one JSON line for each node type that the workflow uses, with its type, title, description and config schema. A tag in any of this is replaced by `<hidden>`.

What is never sent: attachment content, attachment names and ids, memory notes, run data, connection secrets (a workflow holds connection names only), the id, name and description of the agent, the ids and descriptions of its skills, other plans, and anything of the engine's environment. The workflow can hold paths, URLs and channel names that the user asked for: the planner already saw the same data. A test builds a plan with an attachment, a note, a failed run and a connection secret, reviews it, and looks for each marker in the request.

`result.meta` says what left the machine and what it cost: `provider`, `model`, `effort` (`{ requested, effective, native, collapsed }`), `costNote` (present for a provider whose reasoning does not count against the token maximum), `usage`, `costUsd` (`null` when the price is unknown), `repaired`, `agentUsed` (`{ id, name }` of the reviewer the call named), `skillsUsed` (the number of skills in the block that was sent) and `agentDropped` (1 when the block was left out because it held its own tag). A client words the transfer as "the plan and your request" next to the answer.

### The request of a review

The planner got the text of the call and the earlier turns, so the review gets the same user-side text and not only the last message: a follow-up that answers the planner's questions sends a fixed sentence as its text and the real request in the earlier turns. When `plan` ends in a workflow and the user side differs from the text of the call, the engine stores it in the nullable column `review_text` of the plan, and `reviewPlan` sends `review_text` or, when it is null, the request text. A plan stored before migration 8, a plan without earlier turns and a plan that ended in questions or a refusal have no `review_text`. The record that `getPlan` returns is unchanged: `requestText` stays the text of the call, and `review_text` is never part of a plan record.

The text is the `text` of each user turn followed by its answers (`Answers to your questions:` and one `- id: answer` line each, sorted by id, the way the planner is shown them), then the text of the call, in that order and separated by a blank line. It holds no assistant turn, no attachment reference and no result of an earlier plan. It has at most 16,000 characters, counted as code points: when it is longer, the oldest messages are left out whole, `[Earlier messages are left out.]` starts the text, and a text of the call that is longer than the limit on its own is cut at the limit. The scrubber treats it like the request text: an address in it may appear in the review.

### Read-only

`reviewPlan` only reads: the plan, the agent, its skills and the rules. It writes no row (a test compares the full content of every table before and after a review, a failed review, an invalid review and a refused one), emits no event, starts no run and calls nothing but the model provider, once, or twice with the repair. A source scan in the tests checks that the method calls no store method that writes, no method that starts, deploys or saves anything, and that the review module of the planner has no database, file or network access and one provider call. The text of the plan, the request, the agent and the answer is never written to a log, an error message, an error frame or an event; an unexpected failure of `reviewPlan` logs only the error name.

A client that closes its connection while the call runs cancels the call to the provider and gives the place back, and a cancelled or failed review stores nothing. A shutdown of the engine cancels it too.

### The answer

`review.summary` is 1 to 400 characters. `review.findings` has 0 to 10 items, each `{ severity, text, nodeId? }` with `severity` one of `problem`, `warning` and `info`, `text` 1 to 400 characters and `nodeId` the id of a node of the workflow. The answer is checked against the schema and is not cut to fit: a text over 400 characters, an eleventh finding, an unknown severity or an extra key is one of the reasons for the repair call, and an answer that is still wrong after it is `REVIEW_INVALID`. The limits are the same numbers in `@rill/planner` and in `@rill/protocol`, and a test compares them.

The text of the model is untrusted and is scrubbed before it is returned, with the scrubber of the explanation. Every URL with a scheme and `//`, host name, IPv4 address, bracketed IPv6 address, e-mail address and Slack-style recipient, and every path (absolute, `~/`, with a drive letter or a UNC path), that the workflow's own JSON, node ids and titles, the request text and the rules lines do not contain becomes `<hidden>`; invisible format characters and control characters are removed; a text is cut to 400 characters after that. A `nodeId` that the workflow does not have is dropped from its finding and the text stays. The findings are ordered by severity, `problem` first and `info` last, and in the order given inside one severity. Markup in a text stays text, and so does a link with a scheme but no `//` (`javascript:`, `data:`, `mailto:`): it names no host or path, and a client shows it as text.

### Client contract

- `summary` and every `text` are plain text. A client must not render them as links, HTML or markdown, and must not make an address in them clickable. They are advice, not instructions to the app.
- A review never gates anything. The Deploy button, the flags and the plan are the same with or without a review, and a client must not enable, disable or confirm anything because of one.
- The reviewer is a separate call: the user presses a button, and the client names a reviewer agent. The engine never reviews a plan on its own.

## Recipe methods

A recipe is a ready-made, validated workflow with a short form. The user picks one from a gallery, fills in the form and gets a workflow draft, without asking the planner. The recipes and the rules for the form are in `@rill/recipes` (see its README). Both methods work with no model provider, no attachments folder, no configured connection and no network.

| Method | Params | Result |
| --- | --- | --- |
| `listRecipes` | none | `recipes` |
| `instantiateRecipe` | `recipeId`, `values` | `recipeId`, `workflow`, `summary` |

`listRecipes` returns one entry per recipe, in catalogue order: `id`, `title` and `description` (each `{ ko, en }`), `tags`, `params` (the form: `id`, `kind`, `label`, optional `help`, `required`, optional `default`, `min` and `max`, optional `extension` for a file and `connectionKind` for a connection; the kinds are `folder`, `file`, `glob`, `text`, `number`, `cron`, `url`, `connection`, and for the spreadsheet recipes `spreadsheetId`, `driveFile` and `tableName`; the three are additive and `PROTOCOL_VERSION` stays 1, so a client from before them rejects a list that carries them, see the note on closed results above), `nodeTypes` (the node types of the workflow, once each) and `needsConnection` (the form has a `connection` parameter). It never carries a workflow body or the sample values of the recipe.

`instantiateRecipe` turns the values of the form into a workflow draft. `values` maps a parameter id to a string or a number: at most 20 values, each string at most 500 characters. The params object is closed. The engine checks in this order:

1. The recipe exists, or the call fails with `NOT_FOUND` and the fixed text `recipe not found`.
2. Every value against the rules of its parameter kind, and the form for missing required values and keys that no parameter declares. A failure is `RECIPE_INVALID` and each problem is `<param>: <rule>`, such as `schedule: bad_cron`, `message: template_text` or `threshold: below_min`.
3. The filled workflow through `validateWorkflow`, all three stages, with the engine's node registry, its allowed folders and the names of its configured connections (the list that `plan` gets). The same call refuses a file that a node writes into a folder that a folder trigger watches, when the pattern of the trigger matches the name of the file (`inside_watched_folder`, see "Workflow checks" below). Then one more check on the same workflow: a connection whose kind is not the kind that its field needs (the check of `plan`, `connection_kind_mismatch`). A failure is `RECIPE_INVALID` and each problem is `<code> at <pointer>`, such as `path_outside_roots at /nodes/0/config/folder`, `unknown_connection at /nodes/1/config/connection`, `connection_kind_mismatch at /nodes/1/config/connection` or `inside_watched_folder at /nodes/2/config/file`. A warning does not refuse the draft, as with `deploy`.

The message of `RECIPE_INVALID` is the fixed text `the recipe values are not valid`. A problem names the parameter or the position and a rule or an issue code, never a value. A value is not copied into a message, a problem, a log line or an event, and an unexpected failure of `instantiateRecipe` logs only the error name, like `plan`. A key that is not shaped like a parameter id is reported as `?: unknown_param`.

The result is `{ recipeId, workflow, summary }`:

- `workflow` is the draft. The same recipe and values give the same workflow, node ids included, on every call.
- `summary.nodes` lists `{ id, type, title }` for every node, with the title taken from the node definition.
- `summary.sideEffects` is derived from the node definitions, not stored in the recipe: `idempotent` when a node writes a file (`csv.append`) and `external` when a node calls the network or sends a message (`http.request`, `google.sheets.append`, `microsoft.excel.append`, `notify.slack`). It holds each value at most once, in this order, and is empty for a recipe that only reads. It describes what a retry may repeat and does not tell whether content leaves the computer.
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

## Hook methods

A hook ties an engine event to a fixed action, for the whole app. It can send a Slack notice when a run fails or succeeds or when a plan is deployed, switch a workflow off after a number of failures in a row, or only write a line to the activity log. The engine runs the hooks, so they act while no window is open, and `rill-engine serve` runs them too. A hook acts only while the engine process is running. Nothing runs while the engine is stopped, and nothing is replayed when it starts again.

A hook is created, changed or deleted only by an explicit request to `saveHook` or `deleteHook`. No plan, plan result, attachment, run data, recipe or imported file can write one, hooks are not part of any import or export, and the planner package has no database access at all. A test scans the sources for a new write path. `PROTOCOL_VERSION` is still 1.

| Method | Params | Result |
| --- | --- | --- |
| `listHooks` | none | `hooks`, oldest first |
| `saveHook` | `event`, `scope`, `action`, `enabled`, optional `id` | `hook` |
| `deleteHook` | `id` | `deleted` (`false` for an id that is not there) |
| `listHookLog` | optional `limit` (1 to 200, default 50), optional `hookId` | `entries`, newest first |

A hook is `{ id, event, scope, action, enabled, createdAt, updatedAt }`. `saveHook` without `id` creates a hook under a new random id. With an `id` it edits that hook: the id and `createdAt` stay and `updatedAt` moves, and an unknown id is `HOOK_NOT_FOUND`. The four methods work when the engine has no model provider.

### Events

| Event | When |
| --- | --- |
| `run.failed` | A run that is not a dry run finished with the status `failed`. |
| `run.succeeded` | A run that is not a dry run finished with the status `succeeded`. |
| `plan.deployed` | `deployPlan` stored the workflow of a plan. |

`run.failed` and `run.succeeded` come from the `run.finished` event, which has only the run id, so the engine reads the workflow id and the dry run flag from the run record. A dry run never reaches a hook, whether it fails or succeeds. A run that a rule blocked before any node ran, and a run that `recover` finishes after a crash, are ordinary finished runs. `plan.deployed` is an engine event with the fields `workflowId` and `planId`. `deployPlan` emits it once, after the workflow and the plan record are stored, and a deploy that fails emits none. `deploy` does not emit it, and no other event is a hook event: the actions of a hook emit nothing that a hook listens to, so no hook can start another hook.

A hook has a scope: `{ type: 'all' }` for every workflow, or `{ type: 'workflow', workflowId }` for one. A hook that is not enabled does nothing.

### Actions

| Action | Fields | What it does |
| --- | --- | --- |
| `notify` | `connection`, optional `channel` | Posts a fixed message to Slack through a saved connection of kind `slack`. |
| `deactivateAfterFailures` | `count`, 2 to 20 | For the event `run.failed` only. When the failed run is the run of the workflow that finished last and the last `count` finished non-dry runs have all failed, the workflow is switched off through the same path as `deactivate`, if it is active. |
| `record` | none | Writes the log row and nothing else. |

`notify` posts through `postSlackMessage` in `@rill/nodes-core`, the same function that the `notify.slack` node calls, so the request is the same: a bot connection gets `POST https://slack.com/api/chat.postMessage` with the token in the `Authorization` header, a webhook connection gets the text posted to its own address, and the answer is read the same way. The secret comes from the connections of the engine when the hook acts, a post waits at most 15 seconds, and there is no retry. The channel is read for a bot connection only and takes the same grammar as the `channel` of `notify.slack` (1 to 80 characters, no space, no control character). Without a channel the default channel of the connection is used. A webhook connection with a channel is a failed row with the code `connection`.

`deactivateAfterFailures` reads the stored run history, so the count survives a restart and needs no counter. A success between two failures resets it, and a dry run neither counts nor resets. Only finished runs count, in the order in which they finished: a run that is still queued or running is neither one of the last runs nor a reason to wait, so a workflow whose next run is always already queued is still switched off. The check is skipped, with the outcome `skipped_inactive`, when fewer than `count` runs have finished, when the failed run is not the one that finished last (a run that finished after it will be judged by its own event), when a run among the last `count` did not fail, and when the workflow is already inactive. Reactivating is the user's action. Because the history is not cleared, a workflow that the user switches on again while its last `count` finished runs are all failed is switched off by its next failure.

### The message

The text of a `notify` hook is a fixed English sentence with the workflow name in it:

| Event | Text |
| --- | --- |
| `run.failed` | `Workflow "<name>" failed.` |
| `run.succeeded` | `Workflow "<name>" finished.` |
| `plan.deployed` | `Workflow "<name>" was deployed.` |

The name is made safe by `hookWorkflowLabel` in `@rill/protocol`: control characters, line and paragraph separators, bidirectional marks and invisible format characters are removed, a run of spaces becomes one space, the name is cut to 60 characters by code point, and only then `&`, `<` and `>` become `&amp;`, `&lt;` and `&gt;`, so a name cannot make a mention or a `<url|text>` link and an escape is never cut in half. A double quote in the name, and the look-alikes of it (the curly, low and prime forms), becomes a single quote, so the name cannot close the quotes of the sentence and add words of its own. A name with nothing visible left reads `unnamed`. No run data, error text, step output, node id or path ever goes into the message. The name is text that the workflow carries, so up to 60 characters of it appear in the message as written, and Slack may turn a bare address in it into a link. The text of the link is its address, because the `<url|text>` form is escaped.

### Saving a hook

`saveHook` checks the hook before it stores anything, and lists every problem that it finds as `<field>.<rule>: <fixed sentence>`, never the value that was sent. The check itself is `checkHookInput` in `@rill/protocol`, so the fake engine of the desktop app applies the same rules.

| Problem | Meaning |
| --- | --- |
| `scope.unknown_workflow` | The workflow of a workflow scope does not exist. |
| `connection.empty`, `connection.unknown_connection`, `connection.not_slack_connection` | The connection is missing, is not one the engine knows by this exact spelling, or has a kind other than `slack` (a connection without a kind counts as another kind). |
| `connection.control_character`, `.line_separator`, `.bidi_format`, `.format_character`, `.too_long` | The connection name breaks the character rules of other user text, or has more than 128 characters. The name is not changed, because it is looked up by its exact spelling. |
| `channel.whitespace`, `channel.control_character`, `channel.line_separator`, `channel.bidi_format`, `channel.format_character`, `channel.too_long` | The channel breaks the grammar of `notify.slack` or the character rules. The channel is trimmed and composed to NFC first, and an empty channel means no channel. |
| `count.out_of_range` | The count is not a whole number from 2 to 20. |
| `action.only_for_run_failed` | `deactivateAfterFailures` with an event other than `run.failed`. |
| `action.forbidden_by_rule` | A `notify` hook while a `forbidNode` rule names `notify.slack`. |
| `hook.duplicate` | A hook with the same event, scope and action (the same connection and channel, or the same count) is already saved. `enabled` does not make a difference. |

The checks of the connection (`connection.unknown_connection`, `connection.not_slack_connection`) and of the rule (`action.forbidden_by_rule`) apply to a hook that is saved enabled. A hook saved with `enabled: false` is held to the character rules and the other checks only, so a hook can always be switched off, also when its connection is gone or a rule now forbids `notify.slack`; the checks run again when it is switched on. The save does not look inside the connection: a webhook connection with a channel, or a bot connection with no channel and no default channel, is saved, and each event then writes `failed` with the code `connection`.

At most 20 hooks exist (`HOOK_FULL`). Editing a hook when the list is full is allowed. The count and the insert run in one transaction. A text field of the request is capped at four times its limit, only to bound the payload; a text above the limit but under the cap passes the schema and is a problem of its own. The count must be a whole number, but its range is judged by the engine, so `count: 1` is `HOOK_INVALID` and `count: 2.5` is `INVALID_PARAMS`.

### Limits and order

- A `notify` hook has a cooldown of 60 seconds. A matching event less than 60 seconds after the last post of that hook, successful or not, writes `skipped_cooldown` and does nothing. The cooldown belongs to the hook, so a hook with the scope `all` posts at most one message a minute for all workflows together. `record` and `deactivateAfterFailures` have no cooldown.
- A global cap of 30 actions in 10 minutes applies to every hook. An action counts when its row says `ok` or `failed`; a skipped, blocked or rate limited row does not. When the cap is reached, the next actions write `rate_limited` and do nothing, until the oldest counted action is 10 minutes old. A deactivation is the one action that the cap does not stop: it is bounded by the run history and acts at most once for a workflow that is active, and a log of busy `record` hooks must not keep a failing workflow running.
- Both limits are read from the log, measured from the time of the event, so they survive a restart. The log keeps the rows that the limits still read (see "The activity log"), so a flood of skipped rows cannot make a limit forget. The check order for a `notify` hook is the rule, then the cooldown, then the cap.
- Hooks run one at a time, in the order of their creation, after the event has reached every other listener and never inside the run. A run finishes and its promise settles before any hook starts, and a slow Slack call delays only the hooks behind it. An event that arrives while the runner is busy waits in a queue of at most 1000 events. Past that, the oldest waiting event is dropped without a row, so the newest failures still decide a deactivation. The runner uses the hooks as they are when its turn comes, so a hook that was deleted in between is skipped.
- A hook that throws is caught and written as `failed` with the code `unknown`. Nothing is retried. `Engine.idle` waits for the runner, and `Engine.shutdown` stops it: pending events are dropped, a post in flight is aborted and written as `failed`, and no hook starts afterwards.
- With no enabled hook for an event, the runner does no work: no query, no timer and no row. It reads the hooks again only when a hook changes.

### Rules

A `notify` hook is a way to send a message like the node, so it follows the rule that forbids the node. `saveHook` refuses a `notify` hook with `action.forbidden_by_rule` while a `forbidNode` rule names `notify.slack`, and an existing `notify` hook that a rule later blocks writes `blocked_by_rule`, posts nothing and does not start a cooldown. `record` and `deactivateAfterFailures` are not affected. Hooks do not use `http.request`, so `allowHost` does not apply: a post goes only to `slack.com` or to the webhook address of the connection.

### The activity log

Every action, skipped or not, writes one row to `hook_log`: `{ id, hookId, at, event, workflowId, outcome, code }`. `at` is the time of the event. The newest 500 rows are kept, and the oldest are deleted when a row is written. A row that the cooldown or the cap still reads is kept besides, up to 30 rows (an `ok` or `failed` row that is less than 10 minutes older than the row being written), so the table holds at most 530 rows. Deleting a hook, or the workflow that a hook was about, keeps its old rows, because a row has no link to either.

| Outcome | Meaning |
| --- | --- |
| `ok` | The action was done. |
| `failed` | The action was tried and failed, or something went wrong. `code` says what. |
| `skipped_cooldown` | A `notify` hook is in its cooldown. |
| `rate_limited` | The global cap is reached. |
| `blocked_by_rule` | A rule forbids `notify.slack`. |
| `skipped_inactive` | `deactivateAfterFailures` found nothing to do: the workflow is already inactive, or the run history does not match. |

A `failed` row has one code, and every other row has none. The code is a fixed word, never text from Slack, a name or a value: `connection` (the connection is missing, changed, not a Slack connection or cannot post as set), `timeout`, `http_status` (an HTTP error status or a redirect), `slack_error` (Slack answered `ok: false` or something unexpected) and `unknown`. An event whose run record is gone, because its workflow was deleted in between, writes no row. `listHookLog` returns the rows newest first. No row, response, event or log line holds a token, a webhook address, a channel, a connection name or a workflow name.

### Errors

| Code | Meaning |
| --- | --- |
| `HOOK_INVALID` | The hook breaks a rule of Saving a hook; `problems` lists them and never a value |
| `HOOK_FULL` | The 20 hook places are taken; delete one first |
| `HOOK_NOT_FOUND` | `saveHook` got an `id` that is not there |
| `INVALID_PARAMS` | The params are malformed: an unknown field or event or action type, a text above four times its limit, or a count that is not a whole number |

An unexpected failure of `saveHook`, `deleteHook`, `listHooks` or `listHookLog` logs only the error name. Hook values never appear in a log line, an error message or an event.

### What a hook cannot do

- It cannot start a run, a plan, a deploy or a model call. The runner has no way to do any of them: it can read the store, write the log, post to Slack and switch a workflow off. A test scans the runner for each of them.
- It cannot send anything but the fixed sentence, and the only text in it is the sanitised workflow name.
- It cannot act on a dry run, replay an event that the engine missed, or trigger another hook.
- It cannot affect a run. A failing, slow or throwing hook changes neither the status of a run, the events that other listeners get, nor the hooks behind it.
- When a check cannot decide, it does nothing and writes a `failed` row.

### Storage

Migration 8 creates `hooks` (`id`, `event`, `scope_workflow_id` with a foreign key to `workflows`, `action_type`, `connection`, `channel`, `failure_count`, `enabled`, a unique `dedupe_key`, `created_at`, `updated_at`, and checks that tie each action to its fields) and `hook_log`. A database from before this migration migrates forward and keeps its data. `deleteWorkflow` deletes the hooks that have the workflow as their scope in the same transaction.
