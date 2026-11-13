# @rill/protocol (packages/protocol)

Owns the messages between the engine and its clients: the request, response and event schemas, the method table `METHODS`, the error codes and the WebSocket client `RillClient`.

## Run

- `pnpm exec vitest run packages/protocol`

## Rules

- The engine and the renderer talk only through this package. It depends only on the dsl package and typebox.
- `PROTOCOL_VERSION` is 1 and the subprotocol is `rill.v1` (`src/messages.ts`). The client closes the socket with code 1002 when the server says hello with another version (`test/client.test.ts`).
- Keep changes additive. A new method, event type or error code needs no version change. Add a method to `METHODS` with a params schema and a result schema, then add its name to the sorted list in `test/messages.test.ts`.
- Every object schema is closed (`additionalProperties: false`), and the client checks each result against its schema (`src/client.ts`). Code that holds the old schema refuses a new field on an existing params, result or event schema, so add a method instead of widening one.
- List an error code once in `ERROR_CODES`. The schema tests fail on a duplicate.
- Every event the engine emits must match `EngineEventSchema` (`packages/engine/test/events-contract.test.ts`), so add a new event type here first.
- The token travels as the subprotocol `rill.token.<token>` built by `tokenProtocol`, never in the URL (`test/client.test.ts`).
- Limits that both sides apply, such as `AGENT_MAX_ITEMS` and `MEMORY_MAX_INPUT_CHARS`, are exported from here so the window and the engine cannot disagree.
- A schema change reaches the engine and the desktop app. Run `pnpm exec vitest run packages/engine` and `pnpm exec vitest run apps/desktop` as well.

## Do not

- Do not rename or remove a method, an event type or an error code.
- Do not add a field that carries a key, a token or a connection secret to any schema. The window must never receive one.
- Do not import a package above this one. Its only workspace dependency is dsl.
