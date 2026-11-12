# @rill/desktop

The React renderer of the Rill desktop app, built so that every screen can be looked at in Storybook without starting the app, the engine, a network or a model key.

This package holds the screens only. There is no Electron main process, no engine connection and no chat yet. Every screen takes its data as props or reads it through a small `EngineClient` interface (`request` and `onEvent`). The stories and the tests give it a fake client that answers from fixtures.

## What is here

| Screen | Files | What it shows |
| --- | --- | --- |
| Workflow graph | `src/graph/` | A read-only React Flow canvas with a dagre layout from left to right (above 80 nodes or 240 edges it switches to a plain layered grid, because dagre takes seconds on such graphs). Each node card shows its status as an icon plus a word, the attempt count, a retry mark, and badges for external transfer, file writes and network calls. Click or Enter selects a node. |
| Inspector | `src/inspector/` | The settings of the selected node and every attempt of its last run: input, output, error and times. `JsonView` caps depth, rows and string length, so a large value cannot freeze the page. |
| Run history | `src/runs/` | The runs of a workflow with a status, a relative time, a dry-run tag and the start of the error. Picking a run draws its states on the graph. |
| Workspace | `src/workspace/` | The three screens together as in the design: graph in the middle, inspector on the right, history below. Live events from the client change the node cards as they arrive. |
| Shared pieces | `src/ui/`, `src/theme/`, `src/i18n/` | Status chip and icons, color tokens for light and dark, and a typed Korean and English dictionary. |

Run state lives in `src/model/` as pure functions: `statesFromSteps` for a finished run, `reduceEvent` for the live event stream, `displayState` for what a card shows. A trigger writes no step row, so a trigger of an open run is shown as succeeded.

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

To share a static copy: `pnpm --filter @rill/desktop build-storybook` writes `apps/desktop/storybook-static/`, which git ignores.

## Add a story

Every component file in `src/graph`, `src/inspector`, `src/runs`, `src/workspace` and `src/ui` needs a stories file next to it, and `test/stories-smoke.test.tsx` fails when one is missing.

1. Create `Name.stories.tsx` beside `Name.tsx` with a `Meta` that has a `title` such as `Graph/NodeCard`, and one exported story per state worth seeing.
2. Build the data from `src/fixtures` or with the builders in `src/fixtures/workflows.ts`. Fixtures are typed against `@rill/protocol`, so they cannot drift from what the engine sends.
3. A story that needs state or hooks renders a small named component, because hooks cannot run in a `render` function.
4. Run `pnpm --filter @rill/desktop exec vitest run test/stories-smoke.test.tsx`. It renders every story once in Korean with the light theme and once in English with the dark theme, and fails on a thrown error, a `console.error` or `console.warn`, an empty story, or a message key that shows up untranslated.

Every text a person reads goes through `useT()`. Add the key to both `src/i18n/ko.ts` and `src/i18n/en.ts`; a test fails when the two differ.

## Rules for renderer code

`src/` runs in a browser, so it must stay browser-safe:

- It may import types and pure code from `@rill/dsl` and `@rill/protocol`, and only types from `@rill/nodes-core`.
- It must not import `@rill/engine`, `@rill/planner`, `@rill/llm`, `@rill/recipes`, `@rill/eval` or any `node:` module. An ESLint rule, a test that reads the sources and a test that builds every source file for the browser all enforce this.
- Run data (step input and output, errors, trigger payloads) is untrusted. Show it only as text. `dangerouslySetInnerHTML`, `innerHTML`, `eval` and links made from run data are banned, and the tests render `<img onerror>` and `<script>` strings to check that they stay text.
- Status is never shown by color alone: every status has its own icon and a word. A test computes the contrast of every text and background token pair in both themes and requires 4.5 to 1.
- Times are formatted with `Intl` from a `now` prop and an optional `timeZone`, so stories and tests give the same output every day.

## The catalog fixture

`src/fixtures/catalog.json` is the node list the engine serves through `nodeCatalog`. It is generated from the real core registry:

    pnpm --filter @rill/desktop fixtures

`test/catalog-drift.test.ts` fails when the committed file differs from the live registry, so run the command above and commit the result after a node changes.

## Tests

    pnpm --filter @rill/desktop exec vitest run

or `pnpm test` from the root. The desktop tests use Vitest with jsdom and Testing Library, in a project of their own. React Flow needs `ResizeObserver`, `DOMMatrixReadOnly` and a few size getters, which `test/setup.ts` stubs in one place. The logic tests (layout, run state, JSON model, time) run in the node environment. The graph test also runs axe-core on a selected card with run states.

## Not built yet

Chat and the planner dialog, the effort slider, attachments, flag confirmation, memory, the provider picker, the failure explanation card, the recipe gallery, editing and forms, patch mode, the Electron main process and preload, the connection to a running engine, the tray, secret storage and the installer.
