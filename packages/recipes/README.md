# @rill/recipes

A small catalogue of ready-made workflows. A person picks a recipe from a gallery, fills in a short form (a folder, a Slack connection, a threshold, a schedule) and gets a workflow draft without asking the planner. Recipes need no model, no key and no network. The engine serves them through `listRecipes` and `instantiateRecipe` (see the engine README).

A recipe is data: a workflow in which a string or number value may be replaced by a placeholder, plus the form that fills the placeholders.

## Use it

```ts
import { RECIPES, findRecipe, instantiateRecipe } from '@rill/recipes'

const recipe = findRecipe('receipt-folder-to-csv')!
const result = instantiateRecipe(recipe, { watchFolder: '/Users/demo/Receipts', csvFile: '/Users/demo/ledger.csv' })
if ('workflow' in result) deploy(result.workflow)
else console.log(result.problems) // [{ param: 'csvFile', rule: 'required' }]
```

- `instantiateRecipe` fills the defaults of the parameters that are left out, checks every value, and replaces the placeholders. It returns `{ workflow }` or `{ problems }`, never both.
- The same recipe and the same values give the same workflow, node ids and key order included. The result shares nothing with the recipe.
- The package checks the values against the rules of their kind. It does not know the allowed folders or the configured connections. The engine runs the finished workflow through `validateWorkflow` with both (see the engine README), so a folder outside the allowed folders or an unknown connection is refused there.
- `instantiateRecipe` throws a `RecipeDefinitionError` when the recipe itself is written wrongly. That is a defect in the catalogue and the tests catch it, so a caller does not handle it.

## The format

```ts
interface Recipe {
  id: string // kebab-case, unique
  title: { ko: string; en: string }
  description: { ko: string; en: string }
  tags: string[]
  params: RecipeParam[] // the form, in the order it is shown
  workflow: unknown // a Workflow in which a value may be { "$param": "<id>" }
  sample: Record<string, string | number> // one valid value for every parameter, used by the tests
}

interface RecipeParam {
  id: string // [a-z][a-zA-Z0-9]{0,31}
  kind: 'folder' | 'file' | 'glob' | 'text' | 'number' | 'cron' | 'url' | 'connection'
  label: { ko: string; en: string }
  help?: { ko: string; en: string }
  required: boolean
  default?: string | number
  min?: number // number kind only
  max?: number // number kind only
  extension?: string // file kind only: the file name must end with it, such as '.csv'
  connectionKind?: 'slack' | 'http' | 'webhookSecret' | 'google' | 'microsoft' // connection kind only, and required there
}
```

A required parameter has no default and an optional parameter has one. A parameter that is left out takes its default, so there is no placeholder without a value.

The workflow `name` and the fixed Slack messages of the recipes are Korean text. The labels, helps, titles and descriptions come in both languages.

## Placeholders

A placeholder is the object `{ "$param": "<id>" }`, written with `param('<id>')` in the recipe files. It stands for a whole value: the string or number that the person typed.

- `instantiateRecipe` walks the parsed workflow and swaps each placeholder object for the value. It never builds JSON text, never searches and replaces in a string, and never looks at a replaced value again. A value that looks like JSON, such as `{"$param":"other"}`, stays a plain string.
- There is no interpolation. A placeholder cannot sit inside a longer string, in a key, or in an id, a type, an edge, a retry or the workflow name. It can only replace a value inside the `config` of a node.
- A text value that contains `{{` or `}}` is refused, so a value can never become a runtime reference such as `{{n1.output.amount}}`. The references that a recipe needs are written into the recipe, never typed by a person.

Why whole values only: the values come from a form and are untrusted text. If a value could be spliced into a string or into JSON, it could change which field it lands in, which node reads it, or what a reference points at. With whole-value replacement a value can only be the value of the one field the recipe put the placeholder in, and the engine then validates that field with the same checks as any other workflow.

## Parameter kinds

All string kinds share these rules, checked in this order, and the first that fails names the problem: `wrong_type` (not a string), `empty` (only whitespace), `too_long` (more than 500 characters, counted as characters and not as UTF-16 units), `control_character`, `line_separator` (U+2028 and U+2029), `bidi_format` (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069), `format_character` (other invisible format characters, Unicode category Cf, and U+E0100 to U+E01EF) and `template_text` (`{{` or `}}`). These are the character rules of a memory note in the engine. The zero-width joiner and non-joiner are allowed in `text` only, because emoji sequences need them. Every other string kind refuses them.

| Kind | Also required | Rule names it can raise |
| --- | --- | --- |
| `folder` | An absolute path, or `~/` followed by a path. No space or other whitespace before or after it. No `..` segment, with `/` or `\` as separator. A trailing `/` is allowed. | `surrounding_space`, `not_absolute_path`, `parent_segment` |
| `file` | The same as `folder`, and it must not end in `/` or `\`. When the parameter has an `extension`, the file name must end with it, without regard to case, and have at least one character before it. | `surrounding_space`, `not_absolute_path`, `parent_segment`, `trailing_separator`, `wrong_extension` |
| `glob` | A file name pattern: no `/` and no `\`. | `bad_glob` |
| `text` | Nothing more. One line. | none |
| `number` | A finite number from `min` to `max`, both inclusive. Not a string. | `wrong_type`, `not_finite`, `below_min`, `above_max` |
| `cron` | Five fields, accepted by the parser of the cron trigger and firing at some time. | `bad_cron` |
| `url` | Starts with `http://` or `https://` in lower case, has a host, has no whitespace and no user name or password. | `bad_url`, `url_credentials` |
| `connection` | The shape of a name only. The engine checks that the connection is configured and has the `connectionKind` of the parameter. | none |

The exports `PARAM_KINDS`, `PARAM_RULES` (the rule names per kind), `GENERAL_RULES` (`required` and `unknown_param`), `MAX_PARAM_STRING_CHARS` (500) and `MAX_PARAM_VALUES` (20) hold these facts, and the tests prove that every rule in `PARAM_RULES` is reachable and that nothing else is raised.

Notes on the path kinds:

- `~/` is kept as typed in the workflow. The engine expands it where it uses the path (`assertPathAllowed` expands it in `validateWorkflow`, in the folder trigger and in the nodes that read or write a file), so a `~/` path is checked against the allowed folders by what it stands for.
- A bare `~` and `~user/` are refused, as is every relative path.
- Whitespace around a path is refused rather than trimmed, because a folder or file name that differs from what the person meant only by a space would be created or watched silently. A trailing `/` is refused for a file, which cannot end in one, and accepted for a folder, which a pasted path often has.
- The `extension` of a file parameter (`.csv` for the ledger of the receipt recipes) keeps a form from pointing at a folder or at a file such as `~/.zshrc`. It is lower case, a dot and one to eight letters or digits, and a `file` parameter only. The form can use it to filter a file picker.
- Whether the path is inside the allowed folders is the engine's check. This package never touches the file system.

Notes on `url`: a user name or password in a URL would put a secret into the workflow, so it is refused. A token in the query string cannot be told from other text. Credentials belong in a connection, which a recipe can reference but a URL value cannot carry.

### Problems

`checkParams(recipe, values)` returns a list of `{ param, rule }` and nothing else. A problem never holds a value, and `rule` is one of the fixed names above or `required` and `unknown_param`. A key in the values that no parameter declares is `unknown_param`; its `param` is the key when it has the shape of a parameter id and `?` otherwise, so a long or odd key is never echoed. Values with a prototype property (`constructor`, `__proto__`) are never read as a parameter value.

## The catalogue

| Recipe | Form | Nodes |
| --- | --- | --- |
| `receipt-folder-to-csv` | `watchFolder`, `glob` (default `*.pdf`), `csvFile` | folder watch, extract amount, date and vendor with AI (3 attempts), append a CSV row |
| `receipt-big-amount-alert` | the same, plus `threshold` and `slackConnection` | the same, plus a condition (amount greater than the threshold) and a Slack message on the true branch |
| `daily-health-check` | `schedule` (default weekdays at 9:00), `url`, `slackConnection` | cron, GET the URL (2 attempts, a failure continues), condition (the call produced a status), Slack message on the false branch |
| `webhook-to-slack` | `slackConnection` | webhook on `/webhook-to-slack`, Slack message with a fixed text |
| `monthly-reminder` | `schedule` (default first of the month at 9:00), `message` (has a default), `slackConnection` | cron, Slack message with the text of the form |
| `failure-webhook-alert` | `slackConnection`, `failedStatus` (default `failed`) | webhook on `/failure-alert`, condition (`body.status` equals the failure status as text), Slack message on the true branch |

Notes on the recipes:

- The ledger of the two receipt recipes must not be in the watched folder when the pattern matches its name, because the folder trigger would see each new row as a new receipt and send it to the model again. `validateWorkflow` refuses that layout as `inside_watched_folder`, for `deploy` and `plan` as well as for recipes (see the engine README). The sample keeps the ledger one folder above the watched folder.
- `http.request` already fails the node for a redirect and for every answer that is not 2xx, and `daily-health-check` continues after a failure, so the output of the call is empty exactly when the call failed. The condition asks whether a status exists: any 2xx answer, including 201 and 204, is healthy, and the alert goes out on the false branch. A dry run does not call the URL and reports status 0, which counts as an answer, so a dry run sends no alert.
- The condition of `failure-webhook-alert` compares with strict equality, so `{"status": 500}` does not match the text `500`. The help of the parameter says that the sender must send the status as text.
- The Slack connection of a recipe is declared with `connectionKind: 'slack'`, so a form can list only the connections of that kind, and the engine refuses a connection of another kind.

The two webhook recipes use fixed paths because a webhook path is not a parameter kind. `activate` fails with `ACTIVATION_FAILED` for a second workflow on a webhook route that is already in use, so only one active workflow per webhook recipe fits until a path parameter exists.

## Add a recipe

1. Create `src/recipes/<id>.ts` that exports a `Recipe`, and add it to `RECIPES` in `src/recipes/index.ts`.
2. Write the workflow with `param('<id>')` where a person's value goes. Put every reference to another node (`{{n1.output.amount}}`) in the recipe itself.
3. Declare every parameter in `params` and give every parameter a value in `sample`. Make the sample of an optional parameter differ from its default.
4. A required parameter has no default. An optional parameter has a default that passes the rules of its kind. A number parameter has finite `min` and `max`, and no other kind has them.
5. Sample values use `/Users/demo/...` and `https://example.test/...`. No token, secret, personal path, e-mail address or real host.
6. Run `pnpm check`.

The tests refuse a recipe when:

- its shape is wrong, or two recipes share an id;
- a placeholder names a parameter that is not declared, a declared parameter is not used, a placeholder sits in a key, a string spells `$param`, a placeholder object has other keys, or a placeholder is outside the `config` of a node;
- the default or the sample of a parameter breaks its own rules, or the sample misses a parameter or has an extra one;
- an `extension` sits on a parameter that is not a file, a connection has no `connectionKind` or any other parameter has one;
- a node type is missing from the core registry;
- the instantiated sample, or the instantiated required values with defaults, has any issue or warning from `validateWorkflow` (all three stages, allowed folder `/Users/demo`, connection `slack-ops`);
- a `{{` stands outside a genuine node reference, or a literal looks like a token or a real host;
- a path or connection value that should be refused is not refused by the validator.

The engine package holds the rest: every recipe is instantiated over the protocol, deployed, and dry-run through the real executor with a fake model and fake connections.
