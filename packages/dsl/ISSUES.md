# Plan issue codes

A `PlanIssue` is `{ stage, pointer, code, message, hint? }`. `pointer` is an RFC 6901 JSON pointer into
the workflow DSL (for example `/nodes/3/config/row/1`). `code` is stable and listed in `ISSUE_CODES`
(`src/issues.ts`); `message` is short English text and may change. Codes in `WARNING_CODES` never make
`Engine.deploy` reject a workflow.

Stage 1 checks the shape, stage 2 the graph, stage 3 the meaning of each node. `shapeIssues`,
`graphIssues` and `referenceIssues` live in `@rill/dsl`; the rest comes from `validateWorkflow` in
`@rill/nodes-core`. `sortIssues` orders by stage then pointer; `capIssues` keeps 20 by default, errors
first.

| code | stage | level | meaning |
|---|---|---|---|
| `config_json_parse` | 1 | error | a node config sent as JSON text does not parse (planner) |
| `shape_<keyword>` | 1 | error | the workflow does not match `WorkflowSchema`; `<keyword>` is one of `SCHEMA_KEYWORDS` (`type`, `required`, `additionalProperties`, `pattern`, `minLength`, `anyOf`, ... or `invalid`). `required` and `additionalProperties` point at the property itself |
| `unknown_node_type` | 1 | error | `type` is not in the registry; hint lists the catalog |
| `duplicate_id` | 2 | error | a second node uses the same id |
| `trigger_count` | 2 | error | not exactly one `trigger.*` node |
| `edge_unknown_node` | 2 | error | an edge `from` or `to` names no node |
| `trigger_incoming` | 2 | error | an edge leads into the trigger (first such edge) |
| `trigger_edge_when` | 2 | error | an edge from the trigger has `when` |
| `cycle` | 2 | error | the edges contain a cycle |
| `unreachable` | 2 | error | the node cannot be reached from the trigger |
| `kind_mismatch` | 2 | error | a `trigger.*` name is registered as an action, or the reverse |
| `unknown_ref_node` | 3 | error | `{{x.output...}}` names no node |
| `ref_not_upstream` | 3 | error | the referenced node does not run before this one |
| `malformed_template` | 3 | error | a `{{...}}` span is not a valid reference |
| `unknown_output_field` | 3 | error | the referenced field is not in the upstream output schema; hint lists the fields |
| `when_not_branching` | 3 | error | `when` on an edge from a node without `branch` output |
| `when_unknown_label` | 3 | error | `when` is not one of the declared branches; hint lists them |
| `branch_unused` | 3 | warning | a branching node has no labelled outgoing edge |
| `config_<keyword>` | 3 | error | the node config (after placeholders for templates) does not match its `configSchema` |
| `config_rule` | 3 | error | the node's `validate` hook rejects the config (pointer `/nodes/i/config`) |
| `cron_expression` | 3 | error | the cron expression does not parse or never fires |
| `nullable_into_required` | 3 | warning | a whole-value reference to a nullable field feeds a field that rejects null |
| `number_into_integer` | 3 | warning | a reference to a `number` field feeds an `integer` field |
| `path_outside_roots` | 3 | error | a literal path (role `path`) fails the path guard for the allowed roots; hint lists them |
| `inside_watched_folder` | 3 | error | an action writes a file into a folder that a `trigger.folderWatch` watches and the trigger's pattern matches the file name, so every write would start the workflow again; the hint carries the fix; see the engine README, "Workflow checks" |
| `unknown_connection` | 3 | error | a literal connection name (role `connection`) is not configured; hint lists the names |
| `rule_violation` | 3 | error | the workflow breaks a rule the user set (`env.policy`): a forbidden node type (every version, pointer `/nodes/i/type`), or an `http.request` URL (pointer `/nodes/i/config/url`) whose host is not in the allowed hosts, cannot be judged before the run because a template reference sits in its scheme or host part, or is not a valid absolute http or https URL; the hint lists the allowed hosts. With no policy, or an empty one, the code never appears; see the engine README, "Rules" |

Known gap: placeholders stand for the upstream type, not its value, so a nullable number flowing into an
integer field passes the config check and is reported only as the two warnings above; a pattern, range or
enum at a templated pointer is not judged.
