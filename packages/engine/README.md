# @rill/engine

The durable workflow engine, its WebSocket server and the `rill-engine` command line. The wire protocol and its schemas live in `@rill/protocol`.

## Command line

    rill-engine run <workflow.json> [--db <path>] [--payload <json>] [--dry-run] [--allow <dir>]... [--connections <file.json>]
    rill-engine watch <workflow.json> [--db <path>] [--allow <dir>]... [--connections <file.json>] [--port <n>]
    rill-engine serve [--db <path>] [--allow <dir>]... [--connections <file.json>] [--attachments-dir <dir>] [--port <n>] [--webhook-port <n>] [--shutdown-timeout <ms>]
    rill-engine recover [--db <path>] [--allow <dir>]... [--connections <file.json>]

`serve` listens on 127.0.0.1 and reads its access token from `RILL_TOKEN` (16 or more characters). When the variable is not set it prints a generated token in its first output line.

### Connections file

A JSON object that maps a connection name to a secret string, or to an object with a kind:

    {
      "office": "https://hooks.example.test/abc",
      "team": { "secret": "https://hooks.example.test/def", "kind": "slack" }
    }

Nodes can use both forms. The planner is told only about the second form, by name and kind (`slack`, `http` or `webhookSecret`), and never receives a secret. A bad kind or a secret that is not a string stops the command with a usage error.

### Planning

`serve` answers the planner methods below. The planner calls the Anthropic API with the credentials in `ANTHROPIC_API_KEY`; without them `plan` fails with `LLM_UNAVAILABLE`.

The planner only proposes file paths inside the `--allow` folders. With no `--allow` it cannot propose reading or writing files.

`--attachments-dir` is the folder the engine reads plan attachments from. It is created with mode 0700 when it is missing, and it must be inside an `--allow` folder when any is given. Without it, a `plan` request that carries attachments fails with `ATTACHMENT_REJECTED`.

## Planner methods

Five methods turn a request into a workflow and deploy it after the user has confirmed what needs confirming. Every request is a normal protocol request, so the 1 MiB message limit applies.

| Method | Params | Result |
| --- | --- | --- |
| `plan` | `planId`, `text`, `turns`, `attachments`, `effort`, optional `workflowId` and `selection` | `planId`, `result`, `meta` |
| `cancelPlan` | `planId` | `cancelled` |
| `getPlan` | `planId` | `plan` (the stored record) |
| `listPlans` | optional `limit` (1 to 200) | `plans` (summaries, newest first) |
| `deployPlan` | `planId`, `confirmed` | `workflowId` |

### plan

The client chooses `planId`, which must be unused. The engine keeps no conversation: every call carries its own `turns`, at most 40. `text` is 1 to 8000 characters and `effort` is one of `low`, `medium`, `high`, `xhigh` and `max`. Setting `workflowId` gives the planner the stored workflow as context, and adding `selection` (a node id) asks for a patch to that node instead of a new workflow.

`result.kind` is `workflow`, `questions` or `unsupported`. A workflow result carries `flags` and `needsConfirmation`. At most 2 plans run at the same time; a further one fails with `PLAN_BUSY`. A client that disconnects does not cancel its plan, and the record stays readable through `getPlan`.

### Attachments

Attachment bytes never travel over the protocol. Put the file into the attachments folder as `<id>.<ext>`, where `id` is 8 to 64 characters from A-Z, a-z, 0-9, `_` and `-`, and `ext` is 1 to 8 lowercase letters or digits. Then send the reference `{ id, mediaType, name, bytes }` in `attachments` (at most 5 per message, 10 per conversation). The limits are the ones of `llm.extract`: 20 MiB for a PDF, 3.75 MiB for an image and 1 MiB for text.

The engine reads a file only when exactly one file matches the id, it is a regular file, and it is not a symbolic link. Plan records keep the four reference fields and nothing from the file.

### Flags and confirmation

A flag marks a node field whose value did not come from the user's own words (`attachment_origin`, `new_egress_target` or `untrusted_flow`). Each flag has a key, `flagKey(flag)` from `@rill/protocol`, which is the JSON text of `[nodeId, pointer, code]`.

`deployPlan` deploys the planned workflow only when `confirmed` contains every flag key of the plan and nothing else. Otherwise it fails with `PLAN_NOT_CONFIRMED`, and the message names the unconfirmed flags by node and pointer, never by value. It does not activate the workflow or start a run; use `activate` and `startRun` (with `dryRun`) for that.

`deploy` refuses the content of a plan that has flags and has not been deployed yet, with the same error. The comparison ignores the workflow name and key order. It stops accidental deploys, not a client that edits the content first.

### Records and errors

A record has the status `planned`, `failed` or `cancelled`, the effort, the request text, the attachment references, the result and the meta of a planned record, and the confirmed keys once it is deployed. A failed or cancelled record keeps a fixed error text and the redacted repair rounds, never the model's reply.

| Code | Meaning |
| --- | --- |
| `LLM_UNAVAILABLE` | No model provider, or the provider rejected the credentials |
| `PLAN_INVALID` | No valid plan after the repair rounds; `problems` lists `<code> at <pointer>` |
| `PLAN_PROVIDER` | The model provider failed |
| `PLAN_CANCELLED` | The plan was cancelled |
| `PLAN_BUSY` | Too many plans are running |
| `PLAN_EXISTS` | The plan id is already in use |
| `PLAN_NOT_CONFIRMED` | A flag is not confirmed |
| `PLAN_DEPLOYED` | The plan is already deployed, or has no workflow to deploy |
| `ATTACHMENT_REJECTED` | An attachment is missing, too large, of the wrong type or over the count limit |
| `INVALID_PARAMS` | The params are malformed, or the selection does not fit the stored workflow |
| `NOT_FOUND` | The plan or the workflow does not exist |
