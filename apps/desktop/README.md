# @rill/desktop

The React renderer of the Rill desktop app, built so that every screen can be looked at in Storybook without starting the app, the engine, a network or a model key.

The screens take their data as props or read it through a small `EngineClient` interface (`request` and `onEvent`). The stories and the tests give them a fake client that answers from fixtures. The Electron shell that wraps them (main process, engine process, secrets, tray, installer) is described in [The desktop app](#the-desktop-app). The screens are not wired into it yet: the window shows a small status page, and Plan 4e puts the real app screen there.

## What is here

| Screen | Files | What it shows |
| --- | --- | --- |
| Workflow graph | `src/graph/` | A read-only React Flow canvas with a dagre layout from left to right (above 80 nodes or 240 edges it switches to a plain layered grid, because dagre takes seconds on such graphs). Each node card shows its status as an icon plus a word, the attempt count, a retry mark, and badges for external transfer, file writes and network calls. Click or Enter selects a node. |
| Inspector | `src/inspector/` | The settings of the selected node and every attempt of its last run: input, output, error and times. `JsonView` caps depth, rows and string length, so a large value cannot freeze the page. |
| Run history | `src/runs/` | The runs of a workflow with a status, a relative time, a dry-run tag and the start of the error. Picking a run draws its states on the graph. |
| Workspace | `src/workspace/` | The three screens together as in the design: graph in the middle, inspector on the right, history below. Live events from the client change the node cards as they arrive. |
| Failure explanation | `src/explain/` | The "why did it fail" flow for a failed run: a notice of what is sent to the model provider, an effort choice, the explanation card with the likely cause, signal chips, action buttons and an optional fix proposal handed to the chat box as a draft. |
| Recipe gallery | `src/recipes/` | The six ready-made recipes with search and tag filter, a form built from each recipe's params, a draft preview with the graph, side-effect lines and the "external transfer" line, and a deploy button. |
| Chat panel | `src/chat/` | The right pane: a conversation with the planner (questions, workflow preview, unsupported), an effort slider, file attachments, flag confirmation before deploy, a model picker and a notes screen. See the next section. |
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
| `initialEntries`, `initialDraft` | Optional starting conversation and draft text, for stories and tests. |

The conversation lives only in component state: a pure reducer (`src/chat/model/conversation.ts`) holds the entries, the draft, the attachments, the effort and the memory switch. Nothing is written to disk, `localStorage` or `sessionStorage`. The provider side is stateless, so each `plan` request carries the whole history as `turns` (at most 40, the engine's limit); when a conversation reaches the limit the panel asks for a new chat. A new chat keeps the effort and the memory choice and clears the rest.

What the person sees and decides:

- Effort steps: fast `low`, normal `medium` (default), careful `high`, very careful `xhigh`, and `max` under an advanced toggle. A step the active model does not list in `capabilities.effortLevels` is disabled with the reason. The answer shows requested and effective effort when the engine lowered it, and the cost as an upper bound (`null` shows "unknown").
- Send is Ctrl+Enter or Cmd+Enter. Plain Enter is a line break, so a multi-line draft is safe to write. It is never sent while a plan runs, while a file is being added, with an empty draft, with more than 8000 characters or without a model.
- Questions: a default that is one of the options is preselected and counts as an answer. A question with no options is a free text field that starts empty; the model default is shown beside it as a suggestion that the person accepts with a click or types over. A default that is not one of the options is ignored. The planner also treats an unchanged default as model text, never as text the person wrote. Answers travel as the `answers` of a user turn, never as part of the request text, because the planner treats a chosen option differently from text the person wrote.
- Flags: each flag of a plan has its own checkbox, grouped by node. Deploy stays disabled until the confirmed keys equal the flag keys of the plan (`flagKey` from `@rill/protocol`); the engine requires the same.
- Every place that sends something to the model provider says so: the composer notice (request, attached files, notes), the badge on each attached file, the model picker (`dataNote`) and the notes screen.
- A plan that is running can be cancelled and the draft and attachments come back. When the engine has answered `cancelPlan` (or failed to) and the plan request has still not settled, the panel leaves the planning state itself and ignores a late answer for that plan. Closing the panel while a plan runs sends `cancelPlan` and drops the answer.
- Only the newest workflow card can be deployed. An earlier one says that a newer plan replaced it, and its flag boxes and Deploy button are off. While a new plan is being made, every Deploy button is off.
- The notes switch is on only when the engine reported at least one note. While `listMemory` is pending or failed, the composer says "Notes not loaded", leaves notes out of the transfer notice and sends `useMemory: false`, so what the screen says is what leaves the computer.

Text written by the model (summary, questions, options, reason, nearest idea, flag messages) and names of attached files are untrusted. They are shown as plain text only, with bidi, zero-width and control characters made visible as `‹U+202E›`, a length cap and a "show more" button. A test reads the sources of `src/chat` and fails on `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `localStorage`, `sessionStorage`, anchors, `href`, `src` and network calls.

### The attachment port (for the real client)

```ts
interface AttachmentPort {
  add(file: File): Promise<AttachmentRef>
  remove?(id: string): Promise<void>
}
```

The panel validates a file before it calls `add`: the media type must be one of the eight in `AttachmentRefSchema`. A declared type of the eight must agree with the extension (`tool.exe` declared as `image/png` is refused; a declared text type may stand for any text extension, including unknown ones like `.log`); a declared type outside the eight, such as `application/vnd.ms-excel` that Windows gives to `.csv`, falls back to the extension. A dropped folder is skipped even when it is named like a file. PDF up to 20 MiB, image up to 3.75 MiB, text up to 1 MiB, not empty, at most 5 files per message and 10 per conversation. `add` must copy the file into the engine's attachment folder and resolve with the protocol `AttachmentRef` (`id`, `mediaType`, `name`, `bytes`). File bytes never go through the protocol. If `add` rejects, the panel shows the localized text of the error code (`ATTACHMENT_REJECTED` and the others) and never the text of the error. `remove` is optional and best effort. The panel calls it for a file that finished adding after the composer was gone, for the unsent files of a chat that is cleared with New chat, and for the unsent files (and those of a request that was cancelled) when the panel is closed.

### Choosing the model

`plan` has no model field: the engine is started with a provider and a model. So `ModelPicker` is controlled. It shows the table of `llmModels` grouped by provider, marks the active model (`aria-current`), disables providers without a key with a "key needed" label and the environment variable name, and shows the provider's `dataNote`. Choosing a configured model calls `onSelectModel({ provider, model })` and nothing else: the picker never changes its own selection and never says a switch happened. What the callback does (probably restarting the engine) is for the code that owns the engine.

### Notes

`MemoryPanel` lists, adds, edits and deletes the notes that `listMemory`, `saveMemory` and `deleteMemory` handle (at most 20, one line of at most 300 characters). It shows the rule before the engine says it, a 0/20 and 20/20 state, and the "sent to the model provider with every plan" notice. The add field is off until the list has loaded, and both fields stop at 2000 characters, the limit of the protocol. Errors show the localized message of the code (and of the rule for an invalid note), never the text of a note.

### Looking at it and scripting it

`Chat/ChatPanel` has the whole flow: `Flow` answers the first request with three questions, the second with a workflow that has three flags and the later ones with a plain workflow or an unsupported card, so you can click through questions, flag confirmation and deploy. `Errors` fails each send with a different error code. `Nothing configured`, `Long conversation` and `Patch` are the other states. Every story has a "start over" button that builds a new fake engine.

The fake lives in `src/engine/fake-plan.ts`: `withPlanMethods(client, data)` wraps the Plan 4a fake client and answers `plan`, `cancelPlan`, `deployPlan`, `llmModels`, `listMemory`, `saveMemory` and `deleteMemory` with the rules of the engine (parameters are checked with the real protocol schema, the same plan id twice is `PLAN_EXISTS`, two plans at a time, deploy needs exactly the flag keys, notes follow the engine's memory rules). `data.script(params)` decides each answer: return `{ result, meta }`, a `RillError`, or `'hang'` (the plan runs until it is cancelled). The data for stories and tests is built in `src/fixtures/plan.ts`, typed with the protocol types.

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
- `Chat/ChatPanel`: `Flow` is the one to click through. `Chat/PlanResultCard`, `Chat/QuestionCard` and `Chat/FlagConfirm` show each state of the cards, `Chat/Composer` and `Chat/EffortSlider` the input line, and `Chat/ModelPicker` and `Chat/MemoryPanel` the two screens behind it.

To share a static copy: `pnpm --filter @rill/desktop build-storybook` writes `apps/desktop/storybook-static/`, which git ignores.

## Add a story

Every component file in `src/graph`, `src/inspector`, `src/runs`, `src/workspace`, `src/ui`, `src/explain`, `src/recipes` and `src/chat` needs a stories file next to it, and `test/stories-smoke.test.tsx` fails when one is missing.

1. Create `Name.stories.tsx` beside `Name.tsx` with a `Meta` that has a `title` such as `Graph/NodeCard`, and one exported story per state worth seeing.
2. Build the data from `src/fixtures` or with the builders in `src/fixtures/workflows.ts`. Fixtures are typed against `@rill/protocol`, so they cannot drift from what the engine sends.
3. A story that needs state or hooks renders a small named component, because hooks cannot run in a `render` function.
4. Run `pnpm --filter @rill/desktop exec vitest run test/stories-smoke.test.tsx`. It renders every story once in Korean with the light theme and once in English with the dark theme, and fails on a thrown error, a `console.error` or `console.warn`, an empty story, or a message key that shows up untranslated.

Every text a person reads goes through `useT()`. Add the key to both `src/i18n/ko.ts` and `src/i18n/en.ts`; a test fails when the two differ.

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
- The first click opens a notice: "the step record, with secrets hidden, is sent to the model provider", with the provider and model when `model` is given. "Do not ask again in this session" lives in component state only and is forgotten on remount; the notice comes back when `model` changes.
- Effort is `low`, `medium` or `high` (default `medium`). It is not the planner slider.
- While a request runs the panel can be closed. That does not cancel the request on the server, and the card says the answer is thrown away.
- `retry_run` and `deactivate_workflow` ask for confirmation inside the card before `onAction` is called. `open_connections`, `edit_node`, `check_input_file` and `wait_and_retry` call it at once (they navigate or remind; `wait_and_retry` is only a text). `none` shows no button. In the app, `retry_run` and `deactivate_workflow` then ask a second time in a dialog of the app; for a real run the retry dialog lists what will happen, built from the steps and the node catalog, and stays off while the catalog or the steps are not known.
- `onProposeFix` hands the text to the chat box. The host (the integration plan) puts it in the composer as an editable draft. `<hidden>` marks stay visible with a note that those parts were removed on purpose.
- `nodeId` in the `onAction` context comes from the fix proposal or the first signal. It is model or engine text: the host must check that the node exists before it selects it.
- Model text is plain text with a length cap and a "show more" button. A message key is shown for each error code; the server text never reaches the screen.

`src/explain/model/` holds the pure parts (`explainReducer`, `explainErrorKey`, `canExplain`, the label functions), `src/explain/useExplain.ts` the hook, and `src/engine/fake-explain.ts` the Storybook and test wrapper `withExplainMethod(client, script)`, which checks params and answers against the real `explainRun` schema. Fixtures are in `src/fixtures/explain.ts`.

## The recipe panel

`RecipePanel` in `src/recipes/` shows the gallery, then the form of the chosen recipe, then the draft preview.

    interface RecipePanelProps {
      client: EngineClient
      catalog: readonly NodeInfo[]
      connections: readonly { name: string; kind: 'slack' | 'http' | 'webhookSecret' }[]
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

`apps/desktop` is also the macOS app named Rill. The main process starts the engine as a child process, keeps keys and connection secrets in the system keychain, shows a tray icon, can start at login and can be packed into an unsigned installer. The window itself only shows a status page (engine state and ping time) until Plan 4e.

| Part | Files | What it does |
| --- | --- | --- |
| Host API | `src/shared/host-api.ts` | The typed API between the window and the main process, defined once with TypeBox schemas. Main, preload and renderer all check against it. |
| Main process | `src/main/` | Plain modules that take Electron and file system objects as arguments, so Vitest runs them without Electron: `config-store`, `secret-store`, `engine-supervisor`, `attachments`, `ipc-handlers`. Only `index.ts`, `window.ts`, `tray.ts` and `login-item.ts` touch real Electron objects. |
| Preload | `src/preload/` | Exposes `window.rill`, the host API, and nothing else. It never exposes `ipcRenderer`. |
| Status page | `src/renderer-shell/` | Shows the engine state and the ping time through `window.rill` and `RillClient`. Outside the app it says to run it inside the app. |
| Engine bundle | `scripts/bundle-engine.ts` | Bundles `packages/engine` into one `.mjs` file with esbuild. The app starts it with `utilityProcess.fork`. |

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
| `config.json` | Allowed folders, provider, model and the login setting. No secrets. A corrupt file is kept as `config.json.bak` and the defaults are used. |
| `secrets.bin` | The provider keys and the connection secrets, encrypted as one blob with Electron `safeStorage`. A file that cannot be decrypted is moved to `secrets.bin.bak` (or `secrets.bin.bak.1` to `.9` when that name is taken; no backup is ever overwritten) the next time a key or connection is saved, and the keys must be entered again. When all ten names are taken, saving is refused. |
| `rill.db` | The engine database (workflows, runs, plans, memory). |
| `attachments/` | Files the user attached, copied there as `<id>.<ext>` with mode 0600 in a folder with mode 0700. At most 500 files and 512 MiB in total; a file over either limit is refused with `ATTACHMENT_REJECTED`. Half-written `.partial-*` files left by a crash are removed at start. |

When `safeStorage` is not available (no keychain), saving a key or a connection is refused with a clear error and the engine is not started. There is no plaintext fallback. The window never receives a secret: settings return only which providers have a key, and the name and kind of each connection. The engine gets a secret only through the environment of its process: the key of the chosen provider in its own variable (`ANTHROPIC_API_KEY` and so on) and the connections as JSON in `RILL_CONNECTIONS`. No connections file is ever written. The environment of a process is not private on macOS: any process of the same user can read the original environment block of the engine (for example with `ps -E -p <pid>`) without a keychain prompt, and the engine cannot hide it by deleting the variables. This is a known limit of passing secrets by environment. The token alone is enough to drive the engine over `ws://127.0.0.1`. Moving the secrets to a message channel needs a change in the engine CLI and is not done here.

To reset the app, quit it, delete `~/Library/Application Support/Rill`, and delete the keychain item that `safeStorage` made for the app (open Keychain Access and search for "Safe Storage"; the item is named after the app, and "Electron Safe Storage" when started from `dev`).

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

The build is signed ad hoc only. The smoke run is macOS only and was not tried on Windows or Linux. `safeStorage` on a Mac with a locked keychain can show a prompt the first time it is used. A corrupt secrets file means the user must enter the keys again, and the settings page does not tell the user that the file was unreadable yet (the contract has the code `SECRETS_UNREADABLE`, nothing sends it). A single huge `addFromBytes` call is deserialized by Electron before the main process can check its size, so the 21 MiB limit protects the disk, not the memory of that one call. The real `safeStorage` is not used by any automated check, so the first save of a key in a real run is the first time it runs.

## Tests

    pnpm --filter @rill/desktop exec vitest run

or `pnpm test` from the root. The desktop tests use Vitest with jsdom and Testing Library, in a project of their own. React Flow needs `ResizeObserver`, `DOMMatrixReadOnly` and a few size getters, which `test/setup.ts` stubs in one place. The logic tests (layout, run state, JSON model, time) run in the node environment. The graph test also runs axe-core on a selected card with run states.

The tests of the main process, the preload and the build configuration are `test/main-*.test.ts`, `test/renderer-shell.test.tsx` and `test/main-installer-config.test.ts`. They run in the node environment with fakes for Electron, the keychain and the child process; `main-engine-bundle.test.ts` bundles the engine and starts it with plain Node. The `src/main` and `src/preload` folders are node side code, so the browser-only lint rule and the browser build checks skip them.

## Not built yet

The real app screen in the window (the panels above assembled with the workspace, settings, workflow controls), editing and forms for a workflow, patch mode from a node picked on the graph (the chat takes `editContext` as a prop), signing and notarization, auto update, and Windows and Linux builds.

The three panels above are screens only. Still to do in the integration plan (4e): the explain button next to a failed run in the history, putting a fix proposal into the chat composer, doing what the suggested action buttons say (retry, open connections, select a node, turn a workflow off), a dry run and activation after a recipe deploy, and reading the connection names and native file pickers from the host through `window.rill`.
