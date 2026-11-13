# Demo script

A script for a screen recording of about two minutes. It shows the demo scene of Rill from the first sentence to a failed run that explains itself. The texts to type are in Korean, as they are in the recording. The labels use the Korean interface.

Everything here uses synthetic receipts. Nothing in the demo folder is personal data.

## Before you record

Do this once, off camera.

1. Prepare the sample folder.

   ```
   pnpm install
   pnpm demo:prepare
   ```

   The command creates `~/Rill-Demo/` with two folders. `Receipts` holds three synthetic receipts: `receipt-cafe.pdf`, `receipt-snack-bar.png` and `receipt-pharmacy.txt`. `Inbox` is empty and is the folder the workflow will watch. The command never overwrites a file that is already there, refuses to run when `~/Rill-Demo` or a parent folder is a symbolic link, and prints the next steps with your real paths.

2. Start the app in your own terminal: `pnpm --filter @rill/desktop dev`, or open the installed app.
3. Open Settings (설정).
   - Folders: add `~/Rill-Demo` with the folder dialog. The workflow may only read and write inside folders listed here.
   - Provider and model, then Keys: add the key of your model provider. Pick a model that answers quickly, because the planning step must fit in a few seconds of video. The planner evaluation ran on Sonnet only (95.1% and 93.4% of 61 cases in two runs), so try the exact request once with the model you chose before you record.
   - Connections, Slack card: add a connection named `demo-slack` with a Slack bot token. To show a real message, create a Slack app of your own (the card lists the steps), paste its `xoxb-` token and give the connection a default channel. For the failure scene, paste any made-up token that starts with `xoxb-` (for example `xoxb-0000000000-demo-placeholder`). Slack rejects it, the card says so, and "save anyway" keeps it, so the Slack step fails. Read the note after step 11.
4. The first-run card in the workspace lists three items (a folder, a provider key, a Slack connection) with a button for each. It disappears when they are done.
5. Optional, only for the plainer request that leaves the values out: in the notes tab (메모) of the chat panel, save the note `영수증 PDF는 ~/Rill-Demo/Inbox 폴더에 들어와요`. The planner then has less to ask. Notes are sent to the model provider with every request, and the screen says so.
6. Arrange two Finder windows, `~/Rill-Demo/Receipts` and `~/Rill-Demo/Inbox`, next to the app. Have `~/Rill-Demo/ledger.csv` ready to open once it exists.

## The script

| Time | Do | Say or show |
| --- | --- | --- |
| 0:00 | Show the empty window. | One sentence: you describe an automation, Rill builds it, and it runs on this Mac. |
| 0:08 | Type the request in the chat (the first text below, with the three values in it) and press Cmd+Enter, or the send button (보내기). | The effort slider stays on normal (보통). The notice under the input says what goes to the provider (AI 제공자에게 전송돼요). |
| 0:20 | Wait for the plan card. If a questions card (몇 가지 물어볼게요) comes first, answer it with the values below and press 답하기. | Rill asks instead of guessing. With the values in the request it usually has nothing to ask, so skip this row then. |
| 0:35 | Read the plan card: the graph preview and the plain summary. If the card lists items under "확인이 필요한 항목", read each one and tick 확인했어요 for it. | Each flag says why the value needs a look. A path or an address that is not in your own words gets a flag. Values you typed yourself do not, so with the first text the list is usually empty and deploy is already on. |
| 0:50 | Press 배포하기. | The graph appears in the workspace. The extract node carries the "외부 전송" badge, because the file content goes to the model. |
| 0:58 | Press 시험 실행. Replace the sample payload with the JSON below and run it. | The dry run reads the receipt and calls the model. It skips the CSV write and the Slack message. The nodes turn green. |
| 1:08 | Select the extract node. | The inspector shows what the model read: amount 14500 and date 2026-11-11. |
| 1:15 | Press 활성화. | The workflow is live and watches the Inbox. |
| 1:20 | Copy `receipt-cafe.pdf` from `Receipts` to `Inbox` in Finder (hold Option while you drag). | The watcher waits about two to three seconds until the file stops changing. |
| 1:28 | Watch the graph. | The nodes light up one after another, a new run appears in the history, and `ledger.csv` gets a row. |
| 1:36 | The last node (Slack) fails if you used the made-up token. Pick that run in the history and press 왜 실패했나. | A notice says what is sent to the provider: the step record with secrets masked. Press 보내기 in the notice. |
| 1:46 | Read the explanation card. | A plain cause and the suggested actions, for example 연결 설정 열기. The model proposes, and only buttons that the app owns can act. |
| 1:54 | Switch to Storybook (`pnpm --filter @rill/desktop storybook`). | Show `Workspace/Workspace` (the live stories), `Chat/ChatPanel` (the Flow story) and `Explain/ExplainCard`. Every screen has a story with a fake engine, so nobody needs a key to look at it. |
| 2:00 | End. | |

## The texts

The request. It carries the folder, the CSV file and the connection, so the planner should have nothing to ask:

```
~/Rill-Demo/Inbox 폴더에 영수증 PDF가 들어오면 LLM이 금액과 날짜를 뽑아 ~/Rill-Demo/ledger.csv에 쌓고 demo-slack 연결로 슬랙에 알려줘
```

The plainer demo sentence of the project, to show the questions card. The planner suite has no approved case for this sentence, and with two allowed folders (the attachment folder and `~/Rill-Demo`) it may ask or may guess, so try it before you record:

```
폴더에 영수증 PDF가 들어오면 LLM이 금액과 날짜를 뽑아 CSV에 쌓고 슬랙으로 알려줘
```

The answers to the questions of the plainer sentence. The wording of the questions depends on the model, so match each one by meaning:

| Question about | Answer |
| --- | --- |
| The folder to watch | `~/Rill-Demo/Inbox` |
| The CSV file | `~/Rill-Demo/ledger.csv` |
| The Slack connection | `demo-slack` |

Optional, to show the flag gate on purpose: drop a small text file into the chat that says where the receipts arrive (for example the line `영수증은 ~/Rill-Demo/Inbox 폴더에 들어와요`) and use the plainer sentence without naming the folder. A folder that the planner takes from an attachment gets a flag, and deploy waits for your confirmation. Whether the model takes it from the file is not certain, so try it first. The file goes to the model provider like the rest of the request.

The payload of the dry run. The folder trigger sends these fields. Point `file` at the receipt in `Receipts`:

```json
{
  "file": "~/Rill-Demo/Receipts/receipt-cafe.pdf",
  "name": "receipt-cafe.pdf",
  "extension": ".pdf",
  "bytes": 14743,
  "modifiedAt": "2026-11-11T14:32:00.000Z"
}
```

What the café receipt contains: vendor 다온커피 연남점, date 2026-11-11, total 14,500 won. The other two samples are a snack bar (13,500 won, 2026-11-09) and a pharmacy (18,500 won, 2026-11-06).

## Notes for the recording

- The planner answers vary from run to run. Run the request once before the take, and keep the answers that worked.
- The dry run calls the model once, and the real run calls it once more. In the extraction evaluation a receipt cost on average about $0.0002 with Haiku, $0.003 with Sonnet and $0.006 with Opus (averaged over text, PDF and PNG receipts). The cost of planning is shown as an upper bound in the info line of the plan card.
- The folder watcher treats a file as new by its path, modification time and size. A copy with the same name, size and modification time as an earlier one is seen as already handled. If a second take does not start a run, copy the file under another name or run `touch` on it.
- By default the watcher skips files that were already in the folder when the workflow was first activated. That is why the receipts live in `Receipts` and the watched folder is `Inbox`.
- If the plan watches `*.pdf` (the folder node in the inspector shows the pattern), the PNG and the text receipt do not start a run. You can show that by copying them into `Inbox`.
- With your own Slack bot token the run succeeds and no step fails. To show the explanation anyway, open Settings, Connections, remove `demo-slack` and add it again with the made-up token (use "save anyway"), wait for the engine to restart, and copy a receipt under a new name.
- If the deploy is refused with a message about a path outside the allowed folders, the folder from step 3 is missing in Settings. If the ledger is refused because it sits in the watched folder, keep `ledger.csv` in `~/Rill-Demo`, one level above `Inbox`.
- To start over, deactivate the workflow, delete `~/Rill-Demo/ledger.csv` and the copies in `Inbox`, and run `pnpm demo:prepare` again. It only adds what is missing.
