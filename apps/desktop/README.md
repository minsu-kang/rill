# @rill/desktop

The React renderer of the Rill desktop app, built so that every screen can be looked at in Storybook without starting the app, the engine, a network or a model key.

The screens take their data as props or read it through a small `EngineClient` interface (`request` and `onEvent`). The stories and the tests give them a fake client that answers from fixtures. The Electron shell that wraps them (main process, engine process, secrets, tray, installer) is described in [The desktop app](#the-desktop-app). The window shows the app screen in `src/app/`, which wires the screens to the host API and the engine client, as described in [The window](#the-window).

## What is here

| Screen | Files | What it shows |
| --- | --- | --- |
| Workflow graph | `src/graph/` | A read-only React Flow canvas with a dagre layout from left to right (above 80 nodes or 240 edges it switches to a plain layered grid, because dagre takes seconds on such graphs). Each node card shows its status as an icon plus a word, the attempt count, a retry mark, and badges for external transfer, file writes and network calls. Click or Enter selects a node. |
| Inspector | `src/inspector/` | The settings of the selected node and every attempt of its last run: input, output, error and times. `JsonView` caps depth, rows and string length, so a large value cannot freeze the page. |
| Run history | `src/runs/` | The runs of a workflow with a status, a relative time, a dry-run tag and the start of the error. Picking a run draws its states on the graph. |
| Workspace | `src/workspace/` | The three screens together as in the design: graph in the middle, inspector on the right, history below. Live events from the client change the node cards as they arrive. |
| Failure explanation | `src/explain/` | The "why did it fail" flow for a failed run: a notice of what is sent to the model provider, an effort choice, the explanation card with the likely cause, signal chips, action buttons and an optional fix proposal handed to the chat box as a draft. |
| Agents | `src/app/agents/`, `src/chat/AgentPicker.tsx` | The Agents screen (a list, an editor, an import review) and the agent picker in the chat header. See [Agents](#agents). |
| Recipe gallery | `src/recipes/` | The six ready-made recipes with search and tag filter, a form built from each recipe's params, a draft preview with the graph, side-effect lines and the "external transfer" line, and a deploy button. |
| Chat panel | `src/chat/` | The right pane: chat tabs, each a conversation with the planner (questions, workflow preview, unsupported), an effort control, file attachments, flag confirmation before deploy, a model picker, an agent picker and a notes screen. See the next section. |
| App shell | `src/app/` | The top bar, the page container, the Workflows, Recipes, Agents and Settings screens and the chat aside, wired to the host API and the engine client. See [The window](#the-window). |
| Shared pieces | `src/ui/`, `src/theme/`, `src/i18n/` | Status chip and icons, color tokens for light and dark, and a typed Korean and English dictionary. |

Run state lives in `src/model/` as pure functions: `statesFromSteps` for a finished run, `reduceEvent` for the live event stream, `displayState` for what a card shows. A trigger writes no step row, so a trigger of an open run is shown as succeeded.

## The chat panel

`src/chat/ChatPanel.tsx` is the whole right pane as one component that takes its world as props:

| Prop | Meaning |
| --- | --- |
| `client` | An `EngineClient`. The panel calls `plan`, `cancelPlan`, `deployPlan`, `llmModels` and `listMemory`, and never subscribes to events. |
| `port` | An `AttachmentPort`, see below. |
| `catalog` | The node list (`nodeCatalog`) used to title the cards of the preview and the flag groups. |
| `hints` | Optional measured cost and delay per effort step, `{ effort, costUsd?, latencyMs?, basis }`. Without it nothing is shown next to the steps: the numbers must come from evaluation runs, never from this package. |
| `editContext` | Optional `{ workflowId, nodeId? }`. When given, every `plan` request carries `workflowId` and `selection`, which puts the planner in patch mode. |
| `newId` | Optional plan id generator, for tests and stories. The default is `crypto.randomUUID`. |
| `onDeployed`, `onSelectModel`, `onClearEditContext` | Callbacks. The panel does none of these things itself. |
| `initialEntries`, `initialDraft` | Optional starting conversation and draft text for the first chat tab, for stories and tests. |

The conversation lives only in component state: a pure reducer (`src/chat/model/conversation.ts`) holds the entries, the draft, the attachments, the effort and the memory switch. Nothing is written to disk, `localStorage` or `sessionStorage`. The provider side is stateless, so each `plan` request carries the whole history as `turns` (at most 40, the engine's limit); when a conversation reaches the limit the panel offers to open a new chat tab. A new tab starts with the defaults.

What the person sees and decides:

- Composer layout, top to bottom: the text area; one toolbar row with Attach files and the effort control on the left and Send on the right (when the panel is narrower than about 470px the effort control moves to a second line); a small Options line that is closed by default and holds the notes switch and the advanced effort step (when notes exist but are switched off, the closed line says "Notes off" beside the button; the advanced step shows itself in the effort control); and one muted footer with the external transfer notice and the shortcut hint. The transfer notice never needs a click to be seen.
- Effort steps: fast `low`, normal `medium` (default), careful `high`, very careful `xhigh`, and `max` under an advanced toggle. A step the active model does not list in `capabilities.effortLevels` is disabled with the reason. The answer shows requested and effective effort when the engine lowered it, and the cost as an upper bound (`null` shows "unknown").
- Send is Ctrl+Enter or Cmd+Enter. Plain Enter is a line break, so a multi-line draft is safe to write. It is never sent while a plan runs, while a file is being added, with an empty draft, with more than 8000 characters or without a model.
- Questions: a default that is one of the options is preselected and counts as an answer. A question with no options is a free text field that starts empty; the model default is shown beside it as a suggestion that the person accepts with a click or types over. A default that is not one of the options is ignored. The planner also treats an unchanged default as model text, never as text the person wrote. Answers travel as the `answers` of a user turn, never as part of the request text, because the planner treats a chosen option differently from text the person wrote.
- Flags: each flag of a plan has its own checkbox, grouped by node. Deploy stays disabled until the confirmed keys equal the flag keys of the plan (`flagKey` from `@rill/protocol`); the engine requires the same.
- Every place that sends something to the model provider says so: the composer notice (request, attached files, notes, agent settings), the badge on each attached file, the model picker (`dataNote`) and the notes screen.
- A plan that is running can be cancelled and the draft and attachments come back. When the engine has answered `cancelPlan` (or failed to) and the plan request has still not settled, the panel leaves the planning state itself and ignores a late answer for that plan. Closing the panel, or closing the chat tab, while a plan runs sends `cancelPlan` and drops the answer.
- Only the newest workflow card can be deployed. An earlier one says that a newer plan replaced it, and its flag boxes and Deploy button are off. While a new plan is being made, every Deploy button is off.
- The notes switch is on only when the engine reported at least one note. While `listMemory` is pending or failed, the composer says "Notes not loaded", leaves notes out of the transfer notice and sends `useMemory: false`, so what the screen says is what leaves the computer.

Text written by the model (summary, questions, options, reason, nearest idea, flag messages) and names of attached files are untrusted. They are shown as plain text only, with bidi, zero-width and control characters made visible as `‹U+202E›`, a length cap and a "show more" button. A test reads the sources of `src/chat` and fails on `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `localStorage`, `sessionStorage`, anchors, `href`, `src` and network calls.

### Chat tabs

The panel holds up to 8 chats as tabs. `ChatPanel` owns the header (title, the Chat, Model and Notes switch, the model text and the agent picker), the tab strip and the shared views. Each tab is a `Conversation` (`src/chat/Conversation.tsx`) with its own reducer, draft, attachments, effort, notes switch, deploy state and running request. The list of tabs is a pure reducer in `src/chat/model/tabs.ts`.

- Every tab stays mounted while the app runs, and the inactive ones are hidden. Switching between tabs loses nothing. The tabs also survive closing and opening the chat aside, because the app keeps the panel mounted.
- The tabs live in memory only. After a restart of the app there is one empty chat. Nothing is saved to disk.
- The model list and the notes count are loaded once for all tabs. The Model and Notes views are shared, and the tab strip shows only in the Chat view.
- A tab is titled with its first message, cut to 28 characters and shown as plain text with invisible characters made visible. A tab without a message is called "New chat". There is no New chat button: the plus button after the tabs opens a new empty tab and makes it the active one.
- A tab that has a request running shows an activity indicator. An answer that arrives in a tab the person is not looking at lands in that tab and marks it with a dot until the tab is opened. A request that fails in such a tab marks it the same way, and the failure shows when the tab is opened. A tab that was away scrolls to its newest message when something arrived meanwhile, and otherwise returns to where it was read.
- A tab closes with its x button, or with the Delete key while it has the focus. A tab that has messages, a draft, attached files or a running request asks first. Closing sends `cancelPlan` for the running request and asks the port to remove the files that were not sent. Workflows that were deployed from the tab stay. When such a workflow is deleted, the plan card in the tab (open or in the background) goes back to offering Deploy, as the engine allows a plan to be deployed again.
- Requests at the same time: the engine plans at most 2 at once and answers the next with `PLAN_BUSY`. A second tab can send while the first one waits for its answer. A third request at the same time fails in the tab that sent it, with the text of `PLAN_BUSY`, and the text comes back to the draft of that tab.
- Keyboard: the strip is a `tablist`, each tab has `aria-selected` and `aria-controls`, and each conversation is a `tabpanel` labelled by its tab. The arrow keys, Home and End move the focus between the tabs, Enter or Space opens the focused tab. Only the focused tab and its close button are in the Tab order. The strip scrolls sideways and keeps the active tab in view. The close buttons and the activity marks sit beside the tablist, so the tablist holds only tabs.

### The attachment port (for the real client)

```ts
interface AttachmentPort {
  add(file: File): Promise<AttachmentRef>
  remove?(id: string): Promise<void>
}
```

The panel validates a file before it calls `add`: the media type must be one of the eight in `AttachmentRefSchema`. A declared type of the eight must agree with the extension (`tool.exe` declared as `image/png` is refused; a declared text type may stand for any text extension, including unknown ones like `.log`); a declared type outside the eight, such as `application/vnd.ms-excel` that Windows gives to `.csv`, falls back to the extension. A dropped folder is skipped even when it is named like a file. PDF up to 20 MiB, image up to 3.75 MiB, text up to 1 MiB, not empty, at most 5 files per message and 10 per conversation. `add` must copy the file into the engine's attachment folder and resolve with the protocol `AttachmentRef` (`id`, `mediaType`, `name`, `bytes`). File bytes never go through the protocol. If `add` rejects, the panel shows the localized text of the error code (`ATTACHMENT_REJECTED` and the others) and never the text of the error. `remove` is optional and best effort. The panel calls it for a file that finished adding after the composer was gone, for the unsent files of a chat tab that is closed, and for the unsent files (and those of a request that was cancelled) when the panel is closed.

### Choosing the model

`plan` has no model field: the engine is started with a provider and a model. So `ModelPicker` is controlled. It shows the table of `llmModels` grouped by provider, marks the active model (`aria-current`), disables providers without a key with a "key needed" label, and shows the provider's `dataNote`. Choosing a configured model calls `onSelectModel({ provider, model })` and nothing else: the picker never changes its own selection and never says a switch happened. What the callback does (probably restarting the engine) is for the code that owns the engine.

### Notes

`MemoryPanel` lists, adds, edits and deletes the notes that `listMemory`, `saveMemory` and `deleteMemory` handle (at most 20, one line of at most 300 characters). It shows the rule before the engine says it, a 0/20 and 20/20 state, and the "sent to the model provider with every plan" notice. The add field is off until the list has loaded, and both fields stop at 2000 characters, the limit of the protocol. Errors show the localized message of the code (and of the rule for an invalid note), never the text of a note.

### Looking at it and scripting it

`Chat/ChatPanel` has the whole flow: `Flow` answers the first request with three questions, the second with a workflow that has three flags and the later ones with a plain workflow or an unsupported card, so you can click through questions, flag confirmation and deploy. `Errors` fails each send with a different error code. `Nothing configured`, `Long conversation` and `Patch` are the other states. Every story has a "start over" button that builds a new fake engine.

The fake lives in `src/engine/fake-plan.ts`: `withPlanMethods(client, data)` wraps the Plan 4a fake client and answers `plan`, `cancelPlan`, `deployPlan`, `llmModels`, `listMemory`, `saveMemory` and `deleteMemory` with the rules of the engine (parameters are checked with the real protocol schema, the same plan id twice is `PLAN_EXISTS`, two plans at a time, deploy needs exactly the flag keys, a plan whose workflow was deleted can be deployed again, notes follow the engine's memory rules). `data.script(params)` decides each answer: return `{ result, meta }`, a `RillError`, or `'hang'` (the plan runs until it is cancelled). The data for stories and tests is built in `src/fixtures/plan.ts`, typed with the protocol types.

## Look at it

From the repository root, in your own terminal:

    pnpm install
    pnpm --filter @rill/desktop storybook

Open the address it prints (http://localhost:6006). Use the toolbar to switch between light and dark and between Korean and English. The Accessibility panel runs axe on the open story.

Good places to start:

- `Workspace/Workspace`: `Static run`, `Failed run`, and the two `Live` stories. A live story replays engine events with real timers, one per second, and lists them under the screen. Press `Replay` to run it again.
- `Graph/WorkflowGraph`: one story per fixture run, a 30 node graph, and light and dark side by side.
- `Graph/NodeCard`: every status, badges, long text and a node the catalog does not know.
- `Inspector/Inspector` and `Inspector/JsonView`: failed runs, a ten thousand item array, a one megabyte string and hostile data.
- `Explain/ExplainCard`: one story per likely cause, zero to three actions, a fix proposal with a `<hidden>` mark, truncated and repaired answers, an unknown cost, hostile text, and light and dark or Korean and English side by side.
- `Explain/ExplainPanel`: the disabled button for runs that are not failed, the notice, loading, an answer and every error. The stories after the first few click through the flow with a Storybook play function, so open them in the browser (the test run renders only the first screen of each).
- `Recipes/RecipeGallery`, `Recipes/RecipeForm` and `Recipes/FieldInput`: the six recipes, every field kind, problems at fields, general issues, unknown rules and no matching connection.
- `Recipes/DraftPreview` and `Recipes/RecipePanel`: with and without the external transfer line, deploying, deployed and failed, and the whole flow against a fake service.
- `App/Settings/ConnectionsSection`: the empty screen, sign-in not available and connected, one story per auth type of a custom connection, a filled form, a saved one, the errors (missing fields, a bad key name, a duplicate name), no keychain and the 200 connection limit. The Slack card has its own group, `App/Settings/SlackCard`: the empty card, the steps open, a filled form, checking, confirmed, saved but not confirmed, refused with "save anyway", saved anyway, the saved list with two bots and an old webhook, no keychain, and the static overviews (every result, light and dark, Korean and English). The stories that submit a form click through with a play function, so open them in the browser. The saved key placeholder shows in `App/Settings/KeysSection` (`SomeConfigured`).
- `App/Agents/AgentsScreen`: `A few agents` is the start; `Editor with errors`, `New agent`, `Delete confirmation`, `Unsaved changes prompt`, `Import review`, `Import review with problems` and `Export` click through the rest. `Chat/AgentPicker` has the picker in every state (default, custom, long and hostile names, loading, load error, a failing change).
- `Chat/ChatPanel`: `Flow` is the one to click through. `Chat/PlanResultCard`, `Chat/QuestionCard` and `Chat/FlagConfirm` show each state of the cards, `Chat/Composer` and `Chat/EffortSlider` the input line, and `Chat/ModelPicker` and `Chat/MemoryPanel` the two screens behind it.

To share a static copy: `pnpm --filter @rill/desktop build-storybook` writes `apps/desktop/storybook-static/`, which git ignores.

## Add a story

Every component file in `src/graph`, `src/inspector`, `src/runs`, `src/workspace`, `src/ui`, `src/explain`, `src/recipes` and `src/chat` needs a stories file next to it, and `test/stories-smoke.test.tsx` fails when one is missing.

1. Create `Name.stories.tsx` beside `Name.tsx` with a `Meta` that has a `title` such as `Graph/NodeCard`, and one exported story per state worth seeing.
2. Build the data from `src/fixtures` or with the builders in `src/fixtures/workflows.ts`. Fixtures are typed against `@rill/protocol`, so they cannot drift from what the engine sends.
3. A story that needs state or hooks renders a small named component, because hooks cannot run in a `render` function.
4. Run `pnpm --filter @rill/desktop exec vitest run test/stories-smoke.test.tsx`. It renders every story once in Korean with the light theme and once in English with the dark theme, and fails on a thrown error, a `console.error` or `console.warn`, an empty story, or a message key that shows up untranslated.

Every text a person reads goes through `useT()`. Add the key to both `src/i18n/ko.ts` and `src/i18n/en.ts`; a test fails when the two differ.

## Agents

An agent is a name with a persona and instructions. The planner and the failure explanation follow the active one. The engine owns them (see `packages/engine/README.md`); the renderer reads and changes them only through `listAgents`, `saveAgent`, `deleteAgent` and `setActiveAgent`.

**One state for the whole window.** `src/engine/agents.ts` keeps one store per engine client (`agentsStoreFor(client)`, the hook `useAgents(client)`). It loads the list once when the first component subscribes, keeps the list in the engine's order (the built-in Default first, then the saved agents by name), and runs the writes one after another, so the last choice wins. The chat picker, every chat tab, the Agents screen and the explain panel read the same state, so a change on the Agents tab shows in the chat header at once. `useAgentsState(client)` only watches and never loads: the explain panel uses it, so it sends no request of its own. A write that fails with `AGENT_NOT_FOUND` loads the list again.

**The chat header.** `AgentPicker` is a small select next to the model text: the built-in Default (translated, never the engine's text) first, then the saved agents. It stays enabled while a request runs, and a running request keeps the agent it started with. Changing it calls `setActiveAgent` and takes effect for the next request of every chat tab. While the list is loading, or has failed, the picker says so, and the requests carry no `agentId` (an absent id means Default), so what the screen says is what leaves the computer. Each `plan` and `explainRun` request carries `agentId` only for a loaded, non-default agent. The transfer notice names "agent settings" when the active agent has a persona or instructions. An answer says which agent made it (`meta.agentUsed`) and when the settings were left out (`meta.agentDropped`). An error from `setActiveAgent` shows the fixed text of its code, and `AGENT_NOT_FOUND` also reloads the list.

**The Agents tab** (between Recipes and Settings). `AgentsScreen` takes the client and, in the app, the host's file dialogs:

- A list on the left (Default first, then the saved agents by name; the selected one has `aria-current`, the one in use has a mark), "New agent", "Import…" and a count out of 12. At 12 agents both buttons are off and a note says why.
- An editor on the right with the four fields, a counter in code points, the rule as a hint, and a message under a field that breaks a rule. The rules are the engine's: `normaliseAgentField` from `@rill/protocol` checks each field as you type, so the screen and the engine cannot differ. Save is off until something changed and every field is valid; Enter in the name field saves; a double submit sends one request. "Use this agent" makes it the active one and is off while the agent has unsaved changes. Delete asks first, names the agent as plain text and says when Default takes over. Default is read only: no field, no Save, no Delete.
- Unsaved edits are not lost silently. Leaving the editor for another agent, "New agent" or an import asks first (Keep editing or Discard changes), and the draft lives in a small store per client (`src/app/agents/model/view.ts`), so an edit survives a visit to another tab.
- Above the screen: what an agent is, the "external transfer" notice naming agent settings, and the advice not to write secrets, passwords or personal data in them.
- The text of a name or description from the engine is shown as plain text with hidden characters made visible (`‹U+202E›`) and truncated by the layout. A status line (`role="status"`) says what was done and an alert says what failed, always with the fixed text of the error code.

**Import and export (Markdown).** The file looks like this:

    ---
    name: Terse reviewer
    description: Short answers
    ---

    # Persona

    Calm and brief.

    # Instructions

    Name every default you pick.

`parseAgentFile` in `src/app/agents/agent-file.ts` is strict and written by hand (no dependency): at most 64 KiB, no replacement character (text that was not valid UTF-8), the first line is `---`, the front matter holds only `name:` and `description:` once each on a line of their own, and the two headings are exactly `# Persona` and `# Instructions`, once each and in that order, with nothing but blank lines before the first. Any other line that starts with `# ` is a problem; `##` and deeper headings, a bare `---` and a line like `#tag` are text. One leading byte order mark and Windows line endings are accepted. The text of the persona and the instructions must not contain `agent-profile-` in any case. The fields then pass the same normalisation as a save. Every problem is reported with a plain message and, where it belongs to a line, the line number, never the text of the file. `serialiseAgentFile` writes the same format and refuses an agent that has a line starting with `# ` in its persona or instructions, since that line would not read back.

Import opens the system file dialog (`.md`, one file) and shows a review screen: the file name, the parsed fields, every problem, the line "nothing is saved or switched on yet", and the transfer note. The name and the description can be edited there (a name that already exists, ignoring case, must be changed first); the persona and the instructions are shown as they are in the file and are changed by editing the file. Save adds a new agent; the import never makes it active, and cancel saves nothing. Export asks for a file name with the system save dialog and writes the saved agent (it is off while there are unsaved changes).

**The host side.** `dialogs.openText()` returns `{ name, text }` or `undefined` when the dialog is cancelled; `dialogs.saveText({ suggestedName, text })` returns `{ saved }`. Both have TypeBox schemas in `src/shared/host-api.ts` (text up to 64 KiB of UTF-8, a suggested name without control characters or slashes), a preload bridge, IPC handlers and entries in the fake host. `src/main/text-files.ts` reads and writes the file: only a regular file, opened without following links, at most 64 KiB (a larger file is refused from its size before it is read, and one that grew is stopped at 64 KiB plus one byte), and it hands the text over as it is, decoded as UTF-8 with replacement characters, with no parser, no JSON and no normalisation. Errors are the fixed host codes `FILE_TOO_LARGE`, `FILE_REJECTED` and `INTERNAL`; the path and the text never reach a log or an error.

**Fakes and stories.** `src/engine/fake-agents.ts` implements the four methods with the engine's rules and errors, and `withPlanMethods` uses it: the fake planner records the `agentId` of every plan request (`planAgentIds()`) and refuses an unknown id before it runs the script. The Storybook groups are `Chat/AgentPicker`, `App/Agents/AgentsScreen`, `App/Agents/AgentList`, `App/Agents/AgentEditor` and `App/Agents/AgentImportReview`; the screen stories click through the editor with errors, the new agent form, the limit, the delete and unsaved prompts, the import review (clean, with problems, not an agent file, hostile text) and the export.

## The explain panel

`ExplainPanel` in `src/explain/` takes an `EngineClient`, the open run and two callbacks. It never starts a run, turns a workflow off or sends a chat message by itself.

    interface ExplainPanelProps {
      client: EngineClient
      run: RunSummary | undefined
      model?: { provider: string; model: string }
      onAction(action, context: { runId: string; nodeId?: string }): void
      onProposeFix(proposal: { nodeId: string; requestText: string }): void
    }

- The button is enabled for a failed run only. Every other status shows a reason next to it. (The engine also explains a finished run that has a failed step; the panel follows the plan and asks only for failed runs.)
- The first click opens a notice: "the step record, with secrets hidden, is sent to the model provider", with the provider and model when `model` is given. "Do not ask again in this session" lives in component state only and is forgotten on remount; the notice comes back when `model` or the active agent changes. With an agent that has a persona or instructions, the notice adds a line that they are sent too, and the request carries the agent's id (see [Agents](#agents)).
- Effort is `low`, `medium` or `high` (default `medium`). It is not the planner slider.
- While a request runs the panel can be closed. That does not cancel the request on the server, and the card says the answer is thrown away.
- `retry_run` and `deactivate_workflow` ask for confirmation inside the card before `onAction` is called. `open_connections`, `edit_node`, `check_input_file` and `wait_and_retry` call it at once (they navigate or remind; `wait_and_retry` is only a text). `none` shows no button. In the app, `retry_run` and `deactivate_workflow` then ask a second time in a dialog of the app; for a real run the retry dialog lists what will happen, built from the steps and the node catalog, and stays off while the catalog or the steps are not known.
- `onProposeFix` hands the text to the chat box. The host (the integration plan) puts it in the composer as an editable draft. `<hidden>` marks stay visible with a note that those parts were removed on purpose.
- `nodeId` in the `onAction` context comes from the fix proposal or the first signal. It is model or engine text: the host must check that the node exists before it selects it.
- Model text is plain text with a length cap and a "show more" button. A message key is shown for each error code; the server text never reaches the screen.

`src/explain/model/` holds the pure parts (`explainReducer`, `explainErrorKey`, `canExplain`, the label functions), `src/explain/useExplain.ts` the hook, and `src/engine/fake-explain.ts` the Storybook and test wrapper `withExplainMethod(client, script, { agents })`, which checks params and answers against the real `explainRun` schema and, when it is given the fake agents, refuses an unknown `agentId` like the engine. Fixtures are in `src/fixtures/explain.ts`.

## The recipe panel

`RecipePanel` in `src/recipes/` shows the gallery, then the form of the chosen recipe, then the draft preview.

    interface RecipePanelProps {
      client: EngineClient
      catalog: readonly NodeInfo[]
      connections: readonly { name: string; kind: 'slack' | 'http' | 'webhookSecret' | 'google' | 'microsoft' }[]
      onPickPath?(kind: 'folder' | 'file'): Promise<string | undefined>
      onDeployed?(workflowId: string): void
      onAction?(action: 'activate' | 'dry_run', workflowId: string): void
    }

The host contract:

- The protocol has no method that lists connections (the engine reads them from a file at start), so the host passes `connections`. A connection field is a select of the entries whose `kind` matches the param's `connectionKind`. With none it shows a message and no free text.
- `onPickPath` is for a native folder or file dialog (Plan 4d). Without it a folder or file field is a plain text input. A cancelled or failed pick leaves the text alone.
- The form checks only what costs nothing: required, 500 characters, a number range, and text with `{{` or `}}`. Every other rule comes back from `instantiateRecipe` as `RECIPE_INVALID` problems and is shown at the field or in a list. The rule and issue tables are in `src/recipes/model/problems.ts`.
- The cron field has labelled presets and no parser; the server checks the expression.
- Nothing runs on its own. `deploy` is called only from the deploy button, once. After a deploy the panel calls `onDeployed` and offers "dry run" and "activate" buttons that only call `onAction`; running or activating is the host's job.
- Titles, descriptions, labels and help come from the engine in Korean and English and are shown as text.

`src/engine/fake-recipes.ts` has `withRecipeMethods(client, data)` for Storybook and tests. It checks params and answers against the real schemas and answers `deploy` with a fixed id for a workflow it handed out as a draft.

### The recipe fixture

`src/fixtures/recipe-infos.json` holds the recipe list and a draft for each recipe, made by the real engine from each recipe's sample values. Regenerate it after a recipe changes:

    pnpm --filter @rill/desktop exec node --import tsx scripts/make-recipe-fixture.ts

`test/recipes-drift.test.ts` fails when the file differs from what the engine builds now. It also compares the rule table of the form with `GENERAL_RULES` and `PARAM_RULES` of `@rill/recipes` and checks that the table has a message for every issue code of `@rill/dsl` and the connection kind check. These drift tests import the sources of `@rill/recipes` and `@rill/planner` by relative path, because the desktop package does not depend on them (and must not: the renderer cannot import them). The `fixtures` script of `package.json` only builds the node catalog.

## Rules for renderer code

`src/` runs in a browser, so it must stay browser-safe:

- It may import types and pure code from `@rill/dsl` and `@rill/protocol`, and only types from `@rill/nodes-core`.
- It must not import `@rill/engine`, `@rill/planner`, `@rill/llm`, `@rill/recipes`, `@rill/eval` or any `node:` module. An ESLint rule, a test that reads the sources and a test that builds every source file for the browser all enforce this.
- Run data (step input and output, errors, trigger payloads) is untrusted. Show it only as text. `dangerouslySetInnerHTML`, `innerHTML`, `eval` and links made from run data are banned, and the tests render `<img onerror>` and `<script>` strings to check that they stay text.
- `src/explain/` and `src/recipes/` also may not use `localStorage`, `sessionStorage` or a runtime import of `@rill/recipes` or `@rill/planner`; `test/panels-source.test.ts` reads the sources and fails on each. Model text, recipe text and ids from the server are shown only as text, with no link made from them.
- Status is never shown by color alone: every status has its own icon and a word. A test computes the contrast of every text and background token pair in both themes and requires 4.5 to 1.
- Times are formatted with `Intl` from a `now` prop and an optional `timeZone`, so stories and tests give the same output every day.

## The catalog fixture

`src/fixtures/catalog.json` is the node list the engine serves through `nodeCatalog`. It is generated from the real core registry:

    pnpm --filter @rill/desktop fixtures

`test/catalog-drift.test.ts` fails when the committed file differs from the live registry, so run the command above and commit the result after a node changes.

## The desktop app

`apps/desktop` is also the macOS app named Rill. The main process starts the engine as a child process, keeps keys and connection secrets in the system keychain, shows a tray icon, can start at login and can be packed into an unsigned installer. The window shows the app screen from `src/app/`.

| Part | Files | What it does |
| --- | --- | --- |
| Host API | `src/shared/host-api.ts` | The typed API between the window and the main process, defined once with TypeBox schemas. Main, preload and renderer all check against it. |
| Main process | `src/main/` | Plain modules that take Electron and file system objects as arguments, so Vitest runs them without Electron: `config-store`, `secret-store`, `key-check`, `engine-supervisor`, `attachments`, `text-files`, `ipc-handlers`. Only `index.ts`, `window.ts`, `tray.ts` and `login-item.ts` touch real Electron objects. |
| Preload | `src/preload/` | Exposes `window.rill`, the host API, and nothing else. It never exposes `ipcRenderer`. |
| App root | `src/renderer-shell/` | `LiveRoot` renders the app with the theme and with the language of the setting, and sets `<html lang>`. Outside the app, without `window.rill`, it says to run it inside the app. |
| Engine bundle | `scripts/bundle-engine.ts` | Bundles `packages/engine` into one `.mjs` file with esbuild. The app starts it with `utilityProcess.fork`. |

### The window

- Top bar: the brand, the workflow switcher, the four screens (Workflows, Recipes, Agents and Settings), and the chat toggle (narrow windows only). While the engine is connected its state is a small green dot with the tooltip "Engine connected". A visually hidden live region carries the words and the `data-rill-ping` attributes that the smoke check reads. In every other state (connecting, reconnecting, restarting, stopped, no host) the text chip shows again, with the reason and the restart button when the engine is stopped. The external transfer badge and the model are not in the top bar: the model text is in the header of the chat panel and opens the Model view, and the transfer notice stays beside the Send button.
- Page padding: every screen sits in one page container (`src/app/Page.tsx`). It keeps 24px from the window edge, 16px when the window is under 700px wide, and the content is at most 1200px wide and centered.
- Language: Settings, General has a Language select with System default, English and 한국어. The labels are the same in every language. The choice is saved in `config.json` and applies at once. System default follows `navigator.language`: a language that starts with `ko` means Korean, anything else English. `LiveRoot` starts from the system language, draws the app only after the first read of the settings has finished (or after one second), so the language never flashes, switches when the select saves, and keeps `<html lang>` in step. The window title and the native menus do not change.
- Delete a workflow: the Delete button stands after the run buttons. Its dialog names the workflow, says that the run history is deleted too and that it cannot be undone. The engine refuses with `WORKFLOW_BUSY` while a run is queued or running, and the dialog then says that the run is still in progress and to try again when it has finished; for an active workflow it also says to deactivate it first, so that no new run keeps it busy. After a delete the window shows the next workflow, or the empty state, and refreshes the list. Other windows refresh through the `workflow.deleted` event. The focus moves to the workflow switcher, or to the main area when no workflow is left.

### Run it

From the repository root, in your own terminal (this starts a server and a window, so the build agents never run it):

    pnpm install
    pnpm --filter @rill/desktop dev

`dev` bundles the engine and starts electron-vite with hot reload for the renderer. While it is not packaged, the app does not touch the system login items.

### Build the installer

    pnpm --filter @rill/desktop dist

This builds the engine bundle and the app, then runs electron-builder. The result is in `apps/desktop/release/` (git ignores it): a `dmg` and a `zip` for the architecture of the machine that built them, for example `Rill-0.0.0-arm64.dmg`. The app id `app.rill.desktop` is a reverse-DNS placeholder until there is a real domain, and the default Electron icon is used.

If the repository sits in a folder that iCloud Drive syncs (on a default Mac setup `~/Documents` does), the build fails at the signing step with "resource fork, Finder information, or similar detritus not allowed", because the sync adds extended attributes to the packed app. Build into a folder that is not synced instead:

    pnpm --filter @rill/desktop dist -c.directories.output=/private/tmp/rill-release

The build is signed ad hoc (identity `-`), not with a developer certificate, and is not notarized, because there is no signing identity yet. The ad hoc signature verifies (`codesign --verify --deep --strict`), but Gatekeeper does not trust it. On another Mac a downloaded copy is blocked. Remove the quarantine flag once with `xattr -dr com.apple.quarantine /Applications/Rill.app`, or try to open the app once and then use System Settings, Privacy & Security, Open Anyway. Right click, then Open, no longer works on current macOS.

electron-builder also flips the Electron fuses of the packed binary (`electronFuses` in `electron-builder.yml`): `runAsNode`, `enableNodeOptionsEnvironmentVariable`, `enableNodeCliInspectArguments` and `grantFileProtocolExtraPrivileges` are off, `enableEmbeddedAsarIntegrityValidation` and `onlyLoadAppFromAsar` are on. So `ELECTRON_RUN_AS_NODE`, `--inspect` and `NODE_OPTIONS` do nothing in the packed app. `test/main-packed-app.test.ts` reads the fuses and the signature of the packed app when `release/` holds one, and skips otherwise.

### Where data lives

Everything is in `~/Library/Application Support/Rill`:

| File | Content |
| --- | --- |
| `config.json` | Allowed folders, provider, model, the login setting and the language (`system`, `en` or `ko`; a file from an older version without it, or with a value that is not one of these, reads as `system` and keeps the other settings). No secrets. A corrupt file is kept as `config.json.bak` and the defaults are used. |
| `secrets.bin` | The provider keys and the connection secrets (with the auth type of a custom connection, which is not secret), encrypted as one blob with Electron `safeStorage`. A file that cannot be decrypted is moved to `secrets.bin.bak` (or `secrets.bin.bak.1` to `.9` when that name is taken; no backup is ever overwritten) the next time a key or connection is saved, and the keys must be entered again. When all ten names are taken, saving is refused. |
| `rill.db` | The engine database (workflows, runs, plans, memory, agents and the active agent). |
| `attachments/` | Files the user attached, copied there as `<id>.<ext>` with mode 0600 in a folder with mode 0700. At most 500 files and 512 MiB in total; a file over either limit is refused with `ATTACHMENT_REJECTED`. Half-written `.partial-*` files left by a crash are removed at start. |

When `safeStorage` is not available (no keychain), saving a key or a connection is refused with a clear error and the engine is not started. There is no plaintext fallback. The window never receives a secret: settings return only which providers have a key, the name, kind and auth type of each connection, and whether sign-in is available. The engine gets a secret only through the environment of its process: the key of the chosen provider in its own variable (`ANTHROPIC_API_KEY` and so on) and the connections as JSON in `RILL_CONNECTIONS`. No connections file is ever written. The environment of a process is not private on macOS: any process of the same user can read the original environment block of the engine (for example with `ps -E -p <pid>`) without a keychain prompt, and the engine cannot hide it by deleting the variables. This is a known limit of passing secrets by environment. The token alone is enough to drive the engine over `ws://127.0.0.1`. Moving the secrets to a message channel needs a change in the engine CLI and is not done here.

To reset the app, quit it, delete `~/Library/Application Support/Rill`, and delete the keychain item that `safeStorage` made for the app (open Keychain Access and search for "Safe Storage"; the item is named after the app, and "Electron Safe Storage" when started from `dev`).

### The key check

When you save a provider key in Settings, the main process first asks the provider whether it accepts the key (`src/main/key-check.ts`). The request is made by the main process because the window's content security policy allows no outside connection. It is one `GET` of the provider's model list, which is read only and costs nothing:

| Provider | Address | Header that carries the key |
| --- | --- | --- |
| Anthropic | `https://api.anthropic.com/v1/models` | `x-api-key` (and `anthropic-version: 2023-06-01`) |
| OpenAI | `https://api.openai.com/v1/models` | `Authorization: Bearer` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/models` | `x-goog-api-key` |
| Grok | `https://api.x.ai/v1/models` | `Authorization: Bearer` |
| Meta | `https://api.meta.ai/v1/models` | `Authorization: Bearer` |

The addresses are a constant keyed by provider, so nothing the user types reaches an address or a header name. The key is never put in a URL or a query string. No cookies are sent, redirects are refused, the request has the generic `User-Agent: Rill`, and it gives up after 10 seconds. The response body is not returned or stored. For a status 400, and for a 401 from OpenAI, it is read, up to 4 KiB, only to look for the provider's known wording.

The answer becomes one of three verdicts. The rule is conservative: only a clear rejection blocks a key.

| Answer | Verdict | Reason |
| --- | --- | --- |
| 2xx | `valid` | |
| 401 | `invalid` | `unauthorized` |
| 401 from OpenAI whose body says "insufficient permissions" or "missing scopes" (a restricted project key without the model-list scope) | `unverified` | `forbidden` |
| 400 whose body has Gemini's `API_KEY_INVALID` or Grok's "incorrect api key" or "invalid api key" wording | `invalid` | `rejected` |
| Any other 400 | `unverified` | `unexpected_status` |
| 403 | `unverified` | `forbidden` (some providers answer 403 for a valid key in a region they do not support) |
| 429 | `unverified` | `rate_limited` |
| 5xx | `unverified` | `server_error` |
| Network error, refused redirect | `unverified` | `network` |
| No answer in 10 seconds | `unverified` | `timeout` |
| Any other status | `unverified` | `unexpected_status` |

A key that has a space, a control character or a non-ASCII character cannot be sent in a header and cannot be an API key, so nothing is sent: the verdict is `invalid` with the reason `malformed`, and the call throws the host error `KEY_MALFORMED` before anything is saved, with or without `saveAnyway`. The notice then says what is wrong with the key, and has no "save anyway" button. Nothing is sent either when there is no keychain.

`window.rill.secrets.setProviderKey(provider, value, options?)` returns `{ verdict }`. A `valid` or `unverified` key is saved, as before, and the verdict is returned. An `invalid` key is not saved and the call throws the host error `KEY_INVALID`, which crosses the process boundary as the code only. With `{ saveAnyway: true }` the key is checked again and saved whatever the verdict, except a malformed one. Calls for the same provider are ordered by the main process: a save or a removal replaces every earlier save of that provider that is still waiting for its check, and the replaced call throws `SUPERSEDED` and saves nothing, so a slow check can never write an older key over a newer one. The engine restarts only when something was saved and the key of the chosen provider changed, as before.

The Keys section shows "checking" while the request runs, then one of: saved and accepted, saved but not confirmed (with the reason in plain words), or refused with a "save anyway" button. The typed key is held in component state only while the refusal notice is open, and is dropped on save, close, edit or when the row goes away (a refusal that arrives after the row has gone is not kept). The result is in a live region and takes the focus.

The addresses, the headers and the 400 wording come from the vendors' documentation. This project has not called them live yet, so the rule above is untested against the real services: treat a wrong verdict as possible. Because only a clear rejection blocks and "save anyway" always exists, a wrong guess costs one extra click, never a key that cannot be saved. `createFakeHost` takes a `keyChecks` option (a function from provider and key to a verdict, `valid` by default) so stories and tests show every state without a network.

### Slack bot connections

Slack does not need sign-in. You create your own Slack app, install it to your workspace and paste its Bot User OAuth Token (`xoxb-...`) into the Slack card of Settings, Connections. Sign-in (OAuth) is not used because Slack treats a `localhost` redirect as a desktop redirect only for apps that opted into PKCE, and a desktop redirect cannot request bot scopes. The normal flow needs an HTTPS redirect, and a local app without a server has none.

The card has a status chip (Not connected until a bot is saved, Connected when Slack confirmed a saved token, Not confirmed when every saved token was saved without Slack's confirmation), a collapsible "How to get a bot token", then the form: a name, the bot token (a password field) and an optional default channel. The four steps are: create an app at `api.slack.com/apps`; under OAuth & Permissions add the bot scope `chat:write` (and `chat:write.public` to post in channels the bot has not joined); Install to Workspace; copy the Bot User OAuth Token, which starts with `xoxb-`. A note next to the field says that saving asks Slack whether the token works and sends no message. The saved list shows the name, a "Bot" chip, "`<bot>` in `<workspace>`" when the check was confirmed, the default channel, a "Not confirmed" chip when Slack did not confirm that token, and a Remove button. Typing the exact name of a saved Slack connection replaces it (a note says so), which is how a token is rotated or an old webhook becomes a bot; a name that differs only in case, or the name of another kind of connection, is still refused. A webhook connection that was saved earlier shows a "Webhook (old)" chip and keeps working until it is removed; the app no longer creates webhook connections.

When you save, the main process asks Slack whether the token works (`src/main/slack-check.ts`). The window cannot do it because its content security policy allows no outside connection. It is one `POST` with no body to `https://slack.com/api/auth.test`, which posts nothing to any channel. The address is a constant, the token is only in the `Authorization: Bearer` header, no cookies are sent, redirects are refused, the request has the generic `User-Agent: Rill`, and it gives up after 10 seconds. The answer body is read up to 16 KiB. The rule is the same conservative one as the key check: only a clear rejection blocks the token.

| Answer | Verdict | Reason |
| --- | --- | --- |
| HTTP 200 and `ok: true` | `valid` | carries the workspace (`team`) and the bot (`user`) when they are strings |
| HTTP 200 and `ok: false` with `invalid_auth`, `not_authed`, `token_revoked`, `token_expired` or `account_inactive` | `invalid` | `unauthorized` |
| HTTP 401 | `invalid` | `unauthorized` |
| HTTP 200 and `ok: false` with `ratelimited` | `unverified` | `rate_limited` |
| HTTP 200 and any other `ok: false` | `unverified` | `forbidden` |
| 403 | `unverified` | `forbidden` |
| 429 | `unverified` | `rate_limited` |
| 5xx | `unverified` | `server_error` |
| Network error, refused redirect | `unverified` | `network` |
| No answer in 10 seconds | `unverified` | `timeout` |
| A body that is not the expected JSON, or any other status | `unverified` | `unexpected_status` |

The workspace and bot names come from Slack and are untrusted text: control characters, bidirectional overrides and any text that holds the token are removed, they are cut to 80 characters, and the window shows them as text only.

`window.rill.secrets.setSlackBot({ name, token, channel? }, options?)` returns `{ verdict }`. The main process checks the arguments (the token must match `^xoxb-[A-Za-z0-9-]{10,200}$`, the channel is 1 to 80 characters without blanks or control characters), refuses a missing keychain with `NO_KEYCHAIN` and a name that another connection of any kind uses, ignoring case, with `NAME_COLLISION` (a saved Slack connection of the exact same name is replaced), and only then asks Slack. A `valid` or `unverified` token is saved. An `invalid` token is not saved and the call throws the host error `TOKEN_INVALID`, which crosses the process boundary as the code only. With `{ saveAnyway: true }` the token is checked again and saved whatever the verdict. Calls for the same name are ordered like the key check: a newer save or a removal replaces every earlier save of that name that is still waiting, and the replaced call throws `SUPERSEDED`. The engine restarts only when something was saved.

The stored entry keeps the kind `slack` and, as its secret, the JSON text `{"rillSlack":1,"token":"xoxb-...","channel":"#alerts"}` (the channel is optional), which the main process builds from the validated object. `notify.slack` tells a webhook URL, this JSON and a plain `xoxb-` token apart (see "Connections file" in the engine README). The summary that reaches the window has an optional `slack: { mode: 'bot', confirmed?, account?, channel? }` and never the token. `confirmed` is true only when the check was `valid`. A connection without it is a webhook. Files saved before this version load unchanged.

The card shows "checking" while Slack is asked (the form is disabled and a second submit sends nothing more), then one of: connected ("Connected as `<bot>` in `<workspace>`"), saved but not confirmed (with the reason in plain words), or refused with a "save anyway" button. The typed token is held in component state only while the refusal notice is open, and is dropped on save, close, edit or when the card goes away. The result is in a live region and takes the focus.

The endpoint, the headers and the error codes come from Slack's documentation. This project has not called `auth.test` live yet, so the rule above is untested against the real service: treat a wrong verdict as possible. Because only a clear rejection blocks and "save anyway" always exists, a wrong guess costs one extra click, never a token that cannot be saved. `createFakeHost` takes a `slackChecks` option (a function from the token to a verdict, `valid` with a sample workspace and bot by default) so stories and tests show every state without a network.

### Connections and API keys

The Connections section of the settings has four parts: Accounts, Slack, Custom connection and Other saved secrets.

- Accounts: a card for Google and Microsoft, each with a status chip (Not connected, or Connected as the account) and a Connect or Disconnect button. Sign-in is not built yet. The real host reports `oauth.available: false` with no accounts, `oauth.connect` rejects with `OAUTH_UNAVAILABLE`, and the buttons stay disabled with a note. Only the fake host, which Storybook and the tests use, can show a connected account. Slack is not a sign-in account any more: see "Slack bot connections" above.
- Custom connection: a name and an Auth type, as in the Authorization tab of an API client. No Auth sends nothing. API Key adds a key name and a value to a header or to the query string. Bearer Token sends `Authorization: Bearer <token>`. Basic Auth sends `Authorization: Basic` with the base64 of `username:password`. The fields change with the type, and changing the type clears every secret field. A custom connection is chosen in the `auth` setting of an HTTP request node. A name must differ from every other connection of any kind, ignoring case.
- Slack: the bot token card described below. It sits between Accounts and Custom connection.
- Other saved secrets: webhook signing secrets that were saved before. The part shows only while one exists, with a Remove button. New ones cannot be created here.

The host contract accepts the connection kinds `google` and `microsoft` (the secret is an OAuth access token for the spreadsheet nodes), but the screen has no form for them: the Accounts cards are where such a connection will be made once sign-in exists. A saved connection of these kinds is passed to the engine with its kind and is not listed in the sections above.

A custom connection is stored as a connection of kind `http`. Its secret is a JSON text with `"rillAuth": 1` and the auth fields, which the main process builds from a validated `CustomAuth` object (`host.secrets.setCustomConnection`), so the window never assembles a secret string. `http.request` recognises that format (see "Connections file" in the engine README), and any other `http` secret keeps its older meaning. The list shows the name and an auth type chip only.

The host API gained `secrets.setCustomConnection`, `secrets.setSlackBot`, `oauth.connect`, `oauth.disconnect`, `authType` and `slack` on each connection summary, `Settings.oauth` (`available` and `accounts`) and the error codes `OAUTH_UNAVAILABLE` and `TOKEN_INVALID`. `OAuthProvider` is `'google' | 'microsoft'`. In the API keys section, a provider that has a key shows sixteen bullets as the placeholder of its field, next to the Configured chip. The placeholder is the same fixed text for every key and is never derived from a key. Typing replaces it, and no host call returns a key.

### Logo and icons

The mark is a water drop (a rill is a small stream) with a stream that splits in two inside it. The sources are SVG files in `build/`: `icon.svg` is the macOS app icon (a rounded tile with the drop, drawn inside the 824 px safe area of a 1024 px canvas), `icon-small.svg` is the same tile with one dot instead of the split stream, and `tray.svg` is the menu bar icon (a single-colour drop with the dot cut out, used as a template image). `build/icon.png` (1024 px) and `build/icon.icns` are made from them and electron-builder reads `build/icon.icns` (`mac.icon`). In the `.icns`, the 16 px and 32 px entries use `icon-small.svg` because the split stream is not readable that small; the larger entries use `icon.svg`.

In the app, `src/app/Logo.tsx` draws the mark as an inline SVG that takes its colours from the theme tokens (`--accent` for the drop, `--on-accent` for the inside), so it follows light and dark. At 24 px and below it draws the small variant (the drop with one dot), above that the full one. It is decorative (`aria-hidden`) and carries no inline style, which the page policy forbids. The geometry lives in `src/app/logo-geometry.ts`; `test/logo-assets.test.ts` fails when an SVG in `build/` no longer matches it. The menu bar icon is `TRAY_ICON_DATA_URL` in `src/main/tray.ts` (a 32 px PNG of `tray.svg`). When the app runs unpackaged on macOS, the Dock shows `build/icon.png` (`src/main/dock-icon.ts`); a packaged app gets its icon from the bundle.

To make the PNG and `.icns` again after a change to an SVG, render each size from the SVG (sizes 16, 32, 32, 64, 128, 256, 256, 512, 512 and 1024 pixels, named as in an `.iconset` folder: `icon_16x16.png`, `icon_16x16@2x.png`, `icon_32x32.png`, `icon_32x32@2x.png`, and so on), then run `iconutil -c icns <folder>.iconset -o build/icon.icns`.

### The engine process

The main process gives the engine a random token and port 0, reads `{"type":"listening","port":...}` from its output, and tells the window the address through `window.rill.engine.info()` and the current state through `window.rill.engine.status()` (the status events only report changes, so a page that loads late asks once). It restarts the engine, gracefully (10 seconds, then kill), when the provider, model, key, allowed folders or connections change. After a crash it restarts with a back-off of 1, 2, 4, 4 and 4 seconds. On the sixth failure within a minute, or the sixth failed start in a row, it shows the stopped state and waits for the user (the restart button of the window, or a settings change, starts it again). An engine that exits with the usage error code 2 is not retried. Allowed folders are the app's own attachment folder (always the first `--allow`) plus the folders the user chose; with none chosen the engine can only touch attachments. If a change of settings arrives while a restart has already read the old settings, one more restart runs after it, so a removed folder or key never stays in force.

A folder can only be added when the folder dialog returned it in this run; `settings.update` accepts removals, folders that are already allowed and picked folders, nothing else. The main process also refuses `/`, the system folders, the home folder, any folder above the data folder, the data folder itself and links that lead to them, so a workflow cannot reach `config.json` and widen its own access.

### Security settings of the window

`contextIsolation` and `sandbox` are on, `nodeIntegration`, `webviewTag` and `allowRunningInsecureContent` are off, and `webSecurity` is on. The packaged app turns the developer tools off (`devTools: false`) and installs a menu with only the app and edit menus, so there is no View menu with Toggle Developer Tools or Reload. The page is served from the custom scheme `app://rill/` (`src/main/app-protocol.ts`), which maps to the renderer folder only and refuses `..`, encoded slashes, NUL and other hosts; the page is not loaded from `file://`. The page carries a content security policy that allows only the app's own origin and `ws://127.0.0.1:*` and `ws://localhost:*` for connections. New windows and navigation away from the app page are denied, every permission request is denied, and `shell.openExternal` is not exposed. The engine refuses WebSocket requests with an `Origin` header, which the page always sends, so the main process removes that header from requests to `127.0.0.1` and `localhost` for this window only; the token is still required. The window can copy a file into the attachment folder by path only after the user picked that file in the file dialog; dropped files go through `attachments.addFromBytes`.

### Smoke mode

    apps/desktop/release/mac-arm64/Rill.app/Contents/MacOS/Rill --smoke
    pnpm --filter @rill/desktop smoke

`--smoke` starts a hidden window and the engine in a temporary data folder with its own stand-in for `safeStorage` (the real keychain is not touched), waits until the page has connected to the engine and sent `ping`, prints one JSON line such as `{"ok":true,"windowApi":true,"engine":true,"ping":true,"pingMs":2,...}`, stops the engine and exits with 0 (1 on any failure or after 45 seconds). It is the only check of the real Electron chain; the unit tests use fakes. The token and the address are never printed. It counts Content Security Policy violations twice, in the page (`cspViolations`) and as console messages that the main process saw from the start of the load (`cspConsoleMessages`), and any count other than 0 fails the run.

### Known limits

The build is signed ad hoc only. The smoke run is macOS only and was not tried on Windows or Linux. `safeStorage` on a Mac with a locked keychain can show a prompt the first time it is used. A corrupt secrets file means the user must enter the keys again, and the settings page does not tell the user that the file was unreadable yet (the contract has the code `SECRETS_UNREADABLE`, nothing sends it). A single huge `addFromBytes` call is deserialized by Electron before the main process can check its size, so the 21 MiB limit protects the disk, not the memory of that one call. The real `safeStorage` is not used by any automated check, so the first save of a key in a real run is the first time it runs. The same holds for the key check: its addresses and wording rules are from documentation and were never called live.

## Tests

    pnpm --filter @rill/desktop exec vitest run

or `pnpm test` from the root. The desktop tests use Vitest with jsdom and Testing Library, in a project of their own. React Flow needs `ResizeObserver`, `DOMMatrixReadOnly` and a few size getters, which `test/setup.ts` stubs in one place. The logic tests (layout, run state, JSON model, time) run in the node environment. The graph test also runs axe-core on a selected card with run states.

The tests of the main process, the preload and the build configuration are `test/main-*.test.ts`, `test/renderer-shell.test.tsx` and `test/main-installer-config.test.ts`. They run in the node environment with fakes for Electron, the keychain and the child process; `main-engine-bundle.test.ts` bundles the engine and starts it with plain Node. The `src/main` and `src/preload` folders are node side code, so the browser-only lint rule and the browser build checks skip them.

## Not built yet

The real app screen in the window (the panels above assembled with the workspace, settings, workflow controls), editing and forms for a workflow, patch mode from a node picked on the graph (the chat takes `editContext` as a prop), signing and notarization, auto update, and Windows and Linux builds.

The three panels above are screens only. Still to do in the integration plan (4e): the explain button next to a failed run in the history, putting a fix proposal into the chat composer, doing what the suggested action buttons say (retry, open connections, select a node, turn a workflow off), a dry run and activation after a recipe deploy, and reading the connection names and native file pickers from the host through `window.rill`.
