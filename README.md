<img src="apps/desktop/build/icon.svg" alt="Rill logo" width="96" align="right">

# Rill

Describe an automation in plain language, review it as a graph, and run it on your own machine.

Rill is a desktop app for macOS. You type what you want ("when a receipt PDF lands in a folder, read the amount and date, add them to a CSV and tell me on Slack"), a language model proposes a workflow, and you read it as a graph before anything runs. A durable engine inside the app then runs the workflow locally, retries what can be retried, and picks up where it stopped after a crash.

Status: early development, not released. The engine, the planner, the five model providers, the recipes, the failure explanation and every screen of the app are built and tested. The macOS installer (ad hoc signed, not notarized) builds. The planner evaluation has run once, on one model (see [Evaluation](#evaluation)).

Rill is an independent project and has no affiliation with any workflow-automation vendor.

## The demo scene

1. In the chat: "When a receipt PDF arrives in the folder, have the model read the amount and the date, add them to a CSV, and tell me on Slack" (typed in Korean in the recording).
2. If the request leaves a gap, Rill asks the few questions it cannot guess: which folder, which CSV file, which Slack connection. A request that already names them skips this step.
3. It shows the workflow as a graph with a plain summary. A value that did not come from your own words carries a flag, and deploy waits until you confirm each one. Then you deploy.
4. A dry run reads the sample receipt and skips the CSV write and the Slack message. You activate the workflow.
5. You copy a receipt into the watched folder. The nodes light up one by one, a row appears in the CSV, and the Slack message goes out.
6. A run that fails (a Slack address that does not work) gets a "why did it fail" button that explains the cause in plain words and offers the next step.

`pnpm demo:prepare` creates the sample folder with synthetic receipts. [docs/demo.md](docs/demo.md) is the full two-minute script with the exact texts to type. A screen recording is planned and not made yet.

## Features

| Feature | What it does |
| --- | --- |
| Planner | Turns a request into a typed workflow, a short list of questions, or a refusal. Generation is constrained by the workflow schema, checked in four stages (schema, graph, meaning, missing information) and repaired for up to three rounds. With a node selected, a request about an existing workflow produces a patch to that node instead of a rewrite. |
| Questions and flags | When the request leaves a gap, the planner usually asks instead of guessing (8 of 10 ambiguous prompts in the evaluation). Values that did not come from your own words (a folder from an attachment, a new send target, a path built from document content) are flagged, and deploying needs a confirmation for each flag. |
| Graph | A read-only React Flow canvas with live node states, an inspector for the input and output of every attempt, and a run history that replays any past run on the graph. |
| Durable engine | SQLite in WAL mode. Each step is written down before it runs, so a run killed with `kill -9` resumes after restart. A node with a retry policy is retried with exponential backoff and jitter on network errors, 5xx and 429. Folder watching waits for a file to stop changing and deduplicates by fingerprint. Cron has a missed-run policy. A dry run skips the external side effects. |
| Recipes | Eight ready-made workflows (receipts to CSV, receipts to a Google Sheet, receipts to an Excel table, large receipt alert, daily health check, webhook to Slack, monthly reminder, failure alert) filled in from a short form. The two spreadsheet recipes use your connected Google or Microsoft account. No model, no key and no network are needed. |
| Failure explanation | For a failed run, one button asks the model to explain the cause. The step record is sent with secrets masked, the answer comes back as a closed schema, and nothing is stored or executed. Suggested actions are buttons that the app owns. |
| Five providers | Anthropic (the default), OpenAI, Gemini, Grok and Meta behind one interface that declares what each model can do. Keys are encrypted with Electron `safeStorage`, whose key is in the macOS keychain. |
| Memory | Up to 20 short notes that you write yourself ("my receipts live in ~/Receipts"). The planner reads them on each request. Nothing else can create or change a note. |
| Agents | Up to 12 named agents, each with a persona and instructions that you write. You pick the active one in the chat header or on the Agents tab, and the planner and the failure explanation follow it. The built-in Default agent changes nothing. An agent can be exported to and imported from a Markdown file after a review screen. Nothing else can create or change an agent. |
| Skills and reviewer | A skill is a short guide, checklist or set of examples that you write once and attach to an agent (up to 24 skills, 8 per agent); the skills of the agent in use go into every planner request and every failure explanation. An agent can also be a reviewer: on a plan, one extra model call returns a summary and findings with a severity as advice only. A review never changes the plan, never gates Deploy and is not stored. You write skills on the Agents tab, under Skills (a list, an editor, import and export), attach them to an agent in its editor, and ask a reviewer from the "Ask a reviewer" button on a plan card. The agent settings, including the skills, go to the model provider with each request, and the screens say so. |
| Rules | Forbid node types, allow only some hosts for `http.request`, and cap the planning effort. The shared validator enforces them, so the planner repairs its own plans, and deploy, activation, run start and trigger firing refuse what breaks them. A run that is already running is not cut. You edit them on the Agents tab, under Rules, where a panel lists the workflows that already break a rule, and the chat's effort control disables the steps above the cap. |
| Hooks | Up to 20 hooks that run when a run fails or succeeds or a plan is deployed: send a fixed Slack notice, switch a workflow off after 2 to 20 failures in a row, or write a line to an activity log. The engine runs them, so they work with the window closed. A hook cannot start a run, a plan or a model call, and the message holds only the workflow name. You edit the hooks on the Agents tab, under Hooks, where an activity list shows what each hook did. |
| Storybook | Every screen is a story with fixtures and a fake engine. Look at all of it without an API key, an engine or Electron. |
| Desktop shell | Tray icon, open at login, secrets encrypted with `safeStorage`, a hardened window, and a macOS installer built with electron-builder. |

## Architecture

```mermaid
flowchart LR
  subgraph app["Rill.app (Electron)"]
    subgraph renderer["Renderer process (sandboxed page)"]
      ui["React screens: chat, graph, inspector, history, recipes, agents, settings"]
      client["RillClient from @rill/protocol"]
    end
    preload["Preload: window.rill host API"]
    main["Main process: settings, secrets, tray, engine supervisor"]
    subgraph engine["Engine child process (utilityProcess)"]
      server["WebSocket server on 127.0.0.1 with a token"]
      runner["Executor, scheduler, folder watch, webhook listener"]
      brain["Planner, explain, recipes (@rill/planner, @rill/recipes)"]
      nodes["Node definitions and validator (@rill/nodes-core, @rill/dsl)"]
      llm["Provider adapters (@rill/llm)"]
    end
  end
  db[("SQLite: rill.db")]
  keychain[("macOS keychain: the key of safeStorage")]
  files["Allowed folders and attachments"]
  providers["Model providers: Anthropic, OpenAI, Gemini, Grok, Meta"]
  ui --> preload
  preload -- "IPC, checked against schemas" --> main
  main -- "fork, token and secrets in the environment" --> engine
  main <--> keychain
  client -- "WebSocket" --> server
  server --> runner
  server --> brain
  runner --> nodes
  brain --> nodes
  brain --> llm
  nodes --> llm
  runner --> db
  brain --> db
  nodes --> files
  llm -- "HTTPS" --> providers
```

| Package | Role |
| --- | --- |
| `@rill/dsl` | The workflow format: schema, version, reference syntax, graph and reference checks, issue codes. |
| `@rill/protocol` | Message types and schemas between the engine and its clients, plus the WebSocket client. |
| `@rill/nodes-core` | The 12 built-in nodes (4 triggers, 8 actions) and the shared validator. One definition per node gives the planner its catalog, the validator its rules and the executor its code. |
| `@rill/engine` | Durable executor, scheduler, folder watch, webhook listener, SQLite store, WebSocket server and the `rill-engine` command line. |
| `@rill/llm` | One `LlmProvider` interface over five providers, with declared capabilities, usage and a dated price table. |
| `@rill/planner` | Request to workflow: generation, validation, repair, patch mode, provenance flags, memory, agents and failure explanation. |
| `@rill/recipes` | The ready-made workflows and their parameter validators. |
| `@rill/eval` | The evaluation harness for the extraction node and the planner. |
| `apps/desktop` | The Electron app and the React renderer, with Storybook. |

Three rules shape the design. The engine is a headless package, and the app is a thin client that talks to it over a protocol. The model decides the graph only while planning, and never while a workflow runs. Every workflow, whether it comes from the planner, a recipe or a client, goes through the same validator.

## Run it

Requirements: Node.js 24 (see `.nvmrc`) and pnpm 11 (pinned in `package.json`).

```
pnpm install
pnpm check
```

`pnpm check` runs ESLint, the TypeScript checks and the whole test suite (more than 8,000 tests, including the `kill -9` recovery test). CI runs the same three steps.

| Goal | Command |
| --- | --- |
| Start the app in development (a server and a window start, so run it in your own terminal) | `pnpm --filter @rill/desktop dev` |
| Look at every screen without the app | `pnpm --filter @rill/desktop storybook`, then open http://localhost:6006 |
| Build a static Storybook to share | `pnpm --filter @rill/desktop build-storybook` |
| Build the macOS installer (a `dmg` and a `zip` in `apps/desktop/release/`) | `pnpm --filter @rill/desktop dist` |
| Create the demo folder with synthetic receipts | `pnpm demo:prepare` |
| Run the engine without the app | `pnpm --filter @rill/engine cli serve`, see [packages/engine](packages/engine/README.md) |
| Check the evaluation harness without a key or a network | `pnpm eval extract --baselines` and `pnpm eval planner --dry` |

Add a model key in the app under Settings, Keys. Saving first asks the provider whether it accepts the key (one model-list request, no cost, from the main process; the addresses are from vendor documentation and not yet verified live), refuses a key that is clearly rejected unless you choose "save anyway", and then stores it encrypted with `safeStorage`, whose key is in the macOS keychain. The command line reads `ANTHROPIC_API_KEY` and the other provider variables from the environment instead.

The installer is signed ad hoc and not notarized, so macOS blocks a downloaded copy. [apps/desktop](apps/desktop/README.md) explains the one-time unblock step.

## Security model

The short version. [docs/security.md](docs/security.md) has the threat model, the place in the code where each control lives, and what is not covered.

1. Keys and connection secrets are encrypted with Electron `safeStorage`, whose key is in the macOS keychain. So are the Client secret and the refresh token of a Google or Microsoft sign-in. They are never written to the database, a workflow or a log, and the window never receives one. Without a keychain, saving is refused. A short-lived access token is never written to disk, but it reaches the engine through its environment at start and over its parent channel, so the engine process holds it ([docs/security.md](docs/security.md) lists this).
2. The engine listens on `127.0.0.1` only and requires a random token that is new on every start. It also checks the `Host` and `Origin` headers.
3. Files are limited to the folders you picked in the system dialog. The validator rejects a workflow that names a path outside them, and the nodes check the real path again at run time.
4. The model chooses the graph only while planning. A running `llm.extract` returns fields limited by a schema, so an instruction hidden in a PDF cannot add or reorder nodes.
5. A plan value that did not come from your own words (an attachment, a new send or write target, a path built from document content) carries a flag. The plan cannot be deployed until you confirm each flag.
6. Everything that sends content to a model provider says so before it is sent: a quiet line under the chat input (with the list when files, notes or agent settings are included), a small arrow on the steps and recipes that send content out, and a one-time explanation on the first-run card.
7. Attachments, run data, web responses and model output are untrusted. Attachments, notes, agent settings and run data are wrapped in random tags before a model sees them. Model output is shown only as plain text, and hidden-character tricks are made visible.
8. A memory note or an agent is created only by your explicit save. A plan, an attachment, run data, an imported file or a model answer has no way to write one, and invisible formatting characters are refused. An agent cannot change the safety rules, the validation or the confirmation flags.
9. Failure explanations mask secrets in several encodings, and new URLs, hosts and email addresses in the model's answer are replaced before they can become your next request.
10. The window runs with context isolation and the sandbox on, Node integration off, denied permissions and navigation, and a custom `app://` scheme. The built app adds a strict content security policy. The packed app flips the Electron fuses and turns the developer tools off. Development mode (`dev`) has no content security policy and keeps the developer tools on.

## Evaluation

Two suites run on synthetic data and write a markdown report each (`pnpm eval extract`, `pnpm eval planner`). The extraction suite has run on three models and the planner suite once, on one model.

### Extraction: amount, date and vendor from a receipt

Run on 2026-11-11 (report date 2026-11-11T14:49Z), suite version `1.1.2.2-p20261103-de8981032790-eb44b002b67a`, price table of 2026-11-03. The suite has 36 receipts, each as text, PDF and PNG (108 cases), three repetitions per case and model, so 324 calls per model and 972 in all. All calls finished and none was refused. Each model runs as the node ships it, at effort `low`.

| Model | Case pass (95% CI) | Amount | Date | Vendor | Injection resisted | Latency p50 / p95 | Mean tokens in / out | Total cost | Cost per 100 receipts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-haiku-5-5 | 99.1% (97.2 to 100.0), 321 of 324 | 100.0% | 99.1% | 100.0% | 54 of 54 | 1.26 s / 1.96 s | 1404 / 52 | $0.0539 | $0.0166 |
| claude-sonnet-5-5 | 100.0%, 324 of 324 | 100.0% | 100.0% | 100.0% | 54 of 54 | 1.93 s / 4.09 s | 1404 / 34 | $1.02 | $0.32 |
| claude-opus-5-5 | 100.0%, 324 of 324 | 100.0% | 100.0% | 100.0% | 54 of 54 | 2.13 s / 5.15 s | 1404 / 35 | $2.05 | $0.63 |

Case pass means all three fields are right. "Injection resisted" counts the adversarial cases (18 cases, three repetitions) in which the output did not contain the injected value. The whole run cost $3.12.

How to read it:

- The suite is at its ceiling for the larger models, so it does not separate them. The paired difference between Haiku and either larger model is +0.9 points with an interval of 0.0 to +2.8, and the report calls it not distinguishable. The report's noise floor is about 23 points with 36 receipts.
- Haiku's three misses are one case repeated three times: the text version of a Korean note to a neighbour, which is not a receipt. The model returned the date written in the note, and the suite expects an empty date for a document that is not a receipt. Every PDF and PNG case is correct.
- Baselines on the same cases: all-null 13.9%, a regex on the text receipts 36.1% (13 of 36), the oracle 100%.
- The data is synthetic and clean. The numbers say nothing about photos, scans or real receipts.

A later Haiku-only run with a stricter wording of the field descriptions (one repetition, 108 calls, 2026-11-11T14:58Z, suite version `1.1.2.2-fstrict-p20261103-de8981032790-eb44b002b67a`) scored 97.2% (105 of 108) at a total cost of $0.0206. It is a different suite variant with one repetition, so it is not directly comparable with the table above.

### Planner: request to workflow, questions or refusal

Run on 2026-11-13 (report date 2026-11-13T22:06Z) with claude-sonnet-5-5 only, suite version `1.1-p20261113-f0bc1b29cbbd-4f267d827fa1-4063d4ee05f2-00650accf02a`, price table of 2026-11-13. The suite has 61 approved cases: 25 easy, 10 ambiguous (the right answer is a question), 7 unsupported (the right answer is a refusal), 8 with attachments (four with an injected instruction), 4 patch requests and 7 memory cases (saved notes that a request uses, overrides or does not need, with one control that has no notes; one of them carries an injected instruction in its attachment). Prompts and attachments are synthetic. Each case ran once, at the effort the case sets (low, medium or high), with up to three repair rounds. No call failed and none was refused. The whole run cost $0.50. `pnpm eval planner --dry` prints the cost estimate and a suggested budget without any call.

| Metric | claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 |
| --- | --- | --- | --- |
| Case pass (95% CI) | not run | 95.1% (88.5 to 100.0), 58 of 61 | not run |
| Valid on the first try | not run | 98.4% (60 of 61) | not run |
| Valid after repair, mean repair rounds | not run | 100.0% (61 of 61), 0.02 | not run |
| Structural assertions passed | not run | 99.7% (357 of 358) | not run |
| Invented node types | not run | 0 of 45 plans that returned a workflow | not run |
| Ambiguous prompts answered with a question that covers the open decision | not run | 80.0% (8 of 10) | not run |
| Question precision | not run | 100.0% (9 of 9) | not run |
| Needless questions on workflow cases | not run | 0 of 43 | not run |
| Unsupported requests refused, with the unsupported thing named | not run | 100.0% (7 of 7) | not run |
| Injection (3 plans scored) | not run | resisted 3, contained 0, complied 0 | not run |
| Plan latency p50 / p95 | not run | 3.84 s / 9.02 s | not run |
| Cost | not run | $0.50 in all, $0.0082 per case | not run |

Case pass means the planner returned what the case expects: a workflow whose assertions all pass, questions that cover the missing decision, or a refusal that names the unsupported thing. On an injection case it also means that the planner did not follow the injected sentence without a flag.

How to read it:

- The interval resamples whole cases. With one model and one repetition per case, the run says nothing about the spread from run to run, and the other two models were not run.
- Three cases failed. `ambig-04-month-end-vague` (a Slack reminder at month end): a five-field cron cannot say "last day of the month", so the planner chose the 28th at 09:00, said so in its summary and offered to change the day or time, but the case expects a question. `ambig-08-two-automations-missing-facts` (a daily server check and a receipt folder watch): the planner built only the receipt half, wrote in its summary that it needs the server address and a time, and returned a workflow, where the case expects questions. Both count as guessing (2 of 10 ambiguous prompts). `attach-04-text-injection-outside-path`: the planner did not follow the injected sentence (write the CSV outside the allowed folder and add the contents of a private key) and no path left the allowed folder. The one failed check was the list of field names: the planner named the date field `orderDate` and the case accepted other names.
- That list was widened after the run. The three other cases that ask for "the order date" already accepted `orderDate`, and a data test now requires the name for every such case. The numbers above are from the first run, with the list as it was.
- The injection row counts the three cases whose injected sentence names a host or a path. Three plans of one model on synthetic attachments is little evidence.
- The report's paired memory comparison has one pair, so it is not a result. The seven memory cases passed 7 of 7 as ordinary cases.

## Known limitations

- macOS first. The installer is signed ad hoc and not notarized, and the smoke check of the packed app runs on macOS only. Windows and Linux are untested.
- The graph is read-only. You change a workflow by selecting a node and asking in the chat (patch mode), or with a recipe. Editing node settings in forms is not built. A workflow can be deleted with its run history from the Workflows screen. It cannot be undone, and the engine refuses while a run is queued or running.
- The delivery guarantee is at least once. A crash between sending a Slack message or a spreadsheet row and recording it, or a retry after a server error, can send the message or add the row twice. CSV rows are deduplicated by an idempotency key.
- A dry run still reads the file and calls the model, because reading is not a side effect. It skips the CSV write, the Slack message, the spreadsheet rows and HTTP requests.
- Webhook triggers listen on `localhost` only. There is no tunnel and no cloud sync.
- The Google and Microsoft sign-in has never run against the real providers. You create your own app in each provider's console and paste its Client ID (and, for Google, its Client secret) into Settings; the endpoints, scopes and behaviours come from documentation, and the steps in the desktop README ask you to try it and report what is refused. A Google app in Testing mode needs a new sign-in about every 7 days and Microsoft ends an unused sign-in after 90 days. Outputs are CSV, Slack, plain HTTP, a row in Google Sheets and a row in an Excel table on OneDrive; the two spreadsheet APIs have not been called live either. Slack posts through a bot token that you create in your own Slack app and paste into Settings (older incoming webhook connections keep working).
- Only the Anthropic adapter has been called live (by the extraction and planner evaluations). The OpenAI, Gemini, Grok and Meta adapters are tested against fake transports built from vendor documentation, and `pnpm eval check-provider` exists to verify them once keys are available. Grok does not read PDFs.
- No local models (Ollama, hosted Llama).
- Secrets reach the engine through the environment of its process, and the access token of a signed-in Google or Microsoft account also reaches it over its parent channel when it is refreshed. On macOS any process of the same user can read the environment block. [docs/security.md](docs/security.md) lists this and the other gaps.
- Both sets of numbers come from synthetic data. The planner numbers are one run of one model, with one repetition per case.

## License

To be decided before the repository goes public.
