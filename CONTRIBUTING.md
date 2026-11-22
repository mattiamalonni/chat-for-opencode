# Contributing

Thanks for helping improve chat-for-opencode. This extension runs a local `opencode serve` process,
streams its events into a VS Code webview, and keeps the two sides in sync — so most bugs are about
a boundary (host ↔ server, host ↔ webview, or an async race). The checks below exist to catch those.

## Quick start

```sh
node --version   # see .nvmrc
npm ci
npm run compile  # typecheck + esbuild bundles
npm test         # lint, format, typecheck, unit, UI, integration (same gates as CI)
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host. The chat opens in the
secondary side bar. For a real server, install `opencode` 2.2.7 and configure a provider; for most
work the deterministic mock server used by the tests is enough.

## Where things live

| Area                                        | Entry point                                              |
| ------------------------------------------- | -------------------------------------------------------- |
| Extension activation, commands, status bar  | `src/extension.ts`                                       |
| Chat orchestration and command dispatch     | `src/chat/controller.ts`                                 |
| Turn state (status, generation, local idle) | `src/chat/executionState.ts`                             |
| Server process, restart, credentials        | `src/server/server.ts`, `src/server/redact.ts`           |
| HTTP client, SSE parser                     | `src/client/http.ts`, `src/client/sse.ts`                |
| Picker, paging, search                      | `src/chat/sessionListService.ts`                         |
| Webview UI and reducer                      | `src/webview/`, `src/shared/chatReducer.ts`              |
| Protocol and runtime guards                 | `src/shared/protocol.ts`, `src/shared/protocolGuards.ts` |

Architecture notes and API facts: [docs/README.md](docs/README.md).

## Tests: which suite for what

| Command                                       | Covers                                 | Notes                                                                         |
| --------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run test:unit`                           | Pure/host logic with mocks             | Fastest feedback; use for reducers, services, guards, parsers                 |
| `npm run test:ui`                             | Webview in Chromium                    | Uses the recorded 2.2.7 SSE fixtures; no server or provider                   |
| `npm run test:integration`                    | Extension inside VS Code + mock server | Requires a downloaded VS Code (`.vscode-test/`), no credentials               |
| `npm run test:coverage:ui`                    | UI suite + webview line coverage       | Maps Chromium V8 ranges through the source map; gate via `OC_UI_COVERAGE_MIN` |
| `npm run test:coverage`                       | Unit coverage                          | Thresholds in `vitest.config.mts`                                             |
| `npm run test:e2e` / `test:integration:real*` | Real `opencode serve`                  | Opt-in, needs a provider; not part of the push gate                           |

Add a test next to the code you change. A bug fix without a regression test is not a fix. Tests for
protocol changes must cover both valid messages and malformed ones — the runtime guards are a
security boundary, not an implementation detail.

## Before opening a PR

- `npm run verify` passes locally (lint, formatting, typecheck and all three deterministic suites).
- `npm run gen:types` produces no diff when the OpenAPI snapshot changed.
- `CHANGELOG.md` has a short entry for user-visible changes.
- No credentials, absolute machine paths or generated artifacts are committed.
- CI on push/PR is green on Linux, macOS and Windows; the live contract job is advisory.

## Style

Prettier (`npm run format`) and ESLint (`npm run lint`) define the style. Keep line endings LF;
`.editorconfig` and `.gitattributes` enforce that across platforms. Prefer small services with
explicit dependencies over adding more state to `ChatController`.
