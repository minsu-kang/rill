# @rill/desktop (apps/desktop)

Owns the Electron shell (main process, preload, engine supervisor) and the React renderer with its Storybook stories. [README.md](README.md) describes every screen and the shell.

## Run

- `pnpm exec vitest run apps/desktop` runs the desktop tests (jsdom and Testing Library). Add a test file path to run one file.
- Inside `apps/desktop`, `pnpm typecheck` checks the three tsconfig projects, and `pnpm fixtures` regenerates `src/fixtures/catalog.json` after a node changes. The recipe fixture has its own command: see "The recipe fixture" in [README.md](README.md).
- Do not start the `dev`, `storybook` or `smoke` scripts unless the person asks.

## Rules

- The renderer (`src`, except `src/main` and `src/preload`) stays browser-safe: no `node:` or Node built-in module, no import of the engine, planner, llm, recipes or eval packages, and only types from nodes-core. Four guards enforce it: `eslint.config.js`, `test/browser-safe.test.ts`, `test/browser-bundle.test.ts` and `test/lint-restrictions.test.ts`.
- The renderer bans `innerHTML`, `dangerouslySetInnerHTML`, `eval` and `new Function` (`test/browser-safe.test.ts`). `src/app` also bans web storage, links and `console` (`test/app-source-rules.test.ts`). `src/chat` opens no connection (`test/chat-source-rules.test.ts`). `src/explain` and `src/recipes` import no runtime code of the recipes or planner packages (`test/panels-source.test.ts`).
- Show model text, run data and recipe text as text, through `SafeText` (`src/ui/SafeText.tsx`), which marks invisible characters. Build no link from them.
- Every string a person reads goes through `useT()` with a key in both `src/i18n/ko.ts` and `src/i18n/en.ts`. `test/i18n.test.ts` fails on a missing key or a different placeholder.
- Every component file in `src/graph`, `src/inspector`, `src/runs`, `src/workspace`, `src/ui`, `src/explain`, `src/recipes` and `src/chat` needs a stories file with a story for each state. `test/stories-smoke.test.tsx` renders each story in Korean with the light theme and in English with the dark theme, and fails on a console error or warning, an empty story or an untranslated key.
- A control that is disabled while an action runs keeps the keyboard focus: use `useAction` (`src/app/settings/useAction.ts`) or `useKeepFocus` (`src/ui/useKeepFocus.ts`). `test/keep-focus-guard.test.ts` scans every component file and fails on one that does neither and is not on its exception list.
- A title that is not drawn stays in the document with the visually hidden style, never `display: none` (`test/hidden-titles.test.tsx`). Component tests run axe through `test/axe.ts`, with the contrast rule off, because `test/tokens.test.ts` checks a 4.5 to 1 contrast for every text and background token pair in both themes. Status never relies on color alone.
- The preload exposes exactly `HOST_API_METHODS` from `src/shared/host-api.ts` and never `ipcRenderer` (`test/main-preload.test.ts`). Every channel checks its arguments and its result against a closed schema, so a result with an extra field such as a secret is refused (`test/main-host-api.test.ts`).
- Secrets stay in the main process (`src/main/secret-store.ts`, encrypted with `safeStorage`, no plaintext fallback). The window receives status, names and kinds only. `test/app-source-rules.test.ts` fails a `useState` called `secret`, `key`, `apiKey`, `password`, `token` or `value` under `src/app`.
- Window hardening (context isolation, sandbox, denied permissions and navigation) is pinned by `test/main-window.test.ts`.
- Main process modules take Electron and file system objects as arguments, so Vitest runs them without Electron. Only `src/main/index.ts` and `src/preload/index.ts` import `electron`, and `src/main/index.ts` passes the real objects to the other modules.
- `src/fixtures/catalog.json` and `src/fixtures/recipe-infos.json` come from the real registry and recipes. `test/catalog-drift.test.ts` and `test/recipes-drift.test.ts` fail on a difference.

## Do not

- Do not import an engine side package into the renderer. Use the protocol package.
- Do not edit a generated fixture by hand.
- Do not widen the preload or the host API without a schema for the new channel in `src/shared/host-api.ts`.
