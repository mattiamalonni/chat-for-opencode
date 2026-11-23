# Contributing

Thanks for helping improve chat-for-opencode. This extension runs a local `opencode serve` process,
streams its events into a VS Code webview, and keeps the two sides in sync — so most bugs are about
a boundary (host ↔ server, host ↔ webview, or an async race). The checks below exist to catch those.

## Quick start

```sh
node --version   # see .nvmrc
npm ci
npm run compile  # typecheck + esbuild bundles
npm test         # lint, format, docs, types + unit, UI and integration (fast local loop)
npm run verify   # the full CI gate, including audit, coverage floors and the production smoke test
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host. The chat opens in the
secondary side bar. For a real server, install `opencode` 2.3.0 and configure a provider; for most
work the deterministic mock server used by the tests is enough. Install the Playwright browser with
`npx playwright install chromium`; integration tests download VS Code into `.vscode-test/`
(`VSCODE_TEST_VERSION=1.99.3` exercises the minimum supported version).

## Where things live

| Area                                        | Entry point                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| Extension activation and composition root   | `src/extension.ts`                                                                |
| Commands, status bars, auth CLI parsing     | `src/commands.ts`, `src/status/`, `src/auth/`                                     |
| Chat orchestration and command dispatch     | `src/chat/controller.ts`                                                          |
| Turn state (status, generation, local idle) | `src/chat/executionState.ts`                                                      |
| Server process, restart, credentials        | `src/server/server.ts`, `src/server/redact.ts`                                    |
| HTTP client, SSE parser                     | `src/client/http.ts`, `src/client/sse.ts`                                         |
| Picker, paging, search                      | `src/chat/sessionListService.ts`                                                  |
| Webview UI and reducer                      | `src/webview/` (App + view modules), `src/shared/chatReducer.ts` + `chatReducer/` |
| Protocol and runtime guards                 | `src/shared/protocol.ts`, `src/shared/protocolGuards.ts`                          |

Architecture notes and API facts: [docs/README.md](docs/README.md).

## Tests: which suite for what

This is the single list of test commands. Other docs link here instead of repeating it.

### Deterministic — run locally, enforced at release

| Command                    | Covers                                 | Notes                                                                         |
| -------------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run test:unit`        | Pure/host logic with mocks             | Fastest feedback; use for reducers, services, guards, parsers                 |
| `npm run test:ui`          | Webview in Chromium                    | Uses the recorded 2.2.7 SSE fixtures; no server or provider                   |
| `npm run test:integration` | Extension inside VS Code + mock server | Needs a downloaded VS Code (`.vscode-test/`), no credentials                  |
| `npm run test:coverage`    | Unit coverage                          | Thresholds in `vitest.config.mts`                                             |
| `npm run test:coverage:ui` | UI suite + webview line coverage       | Maps Chromium V8 ranges through the source map; gate via `OC_UI_COVERAGE_MIN` |
| `npm run test:ui:prod`     | Minified production bundle             | Smoke test for the artefact that actually ships                               |
| `npm test`                 | The three deterministic suites         | `pretest` also runs lint, formatting, typecheck, docs and generated types     |
| `npm run verify`           | Everything above plus audit            | The full local equivalent of CI                                               |

### Real server — opt-in, needs a provider

| Command                             | Covers                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run test:e2e`                  | Live OpenCode 2.3.0 contract; advisory, manual CI dispatch only                         |
| `npm run test:integration:e2e`      | Real webview inside VS Code, CDP clicks against the **mock** server                     |
| `npm run test:integration:real`     | Extension inside VS Code against a real server, driven through its message API          |
| `npm run test:integration:real:e2e` | Real webview clicks plus a real server: types a prompt and waits for the streamed reply |

The last three need a provider configured; see [MANUAL_TEST.md](docs/MANUAL_TEST.md) for what they
still leave to a human.

### Generated artefacts and documentation

| Command                | Checks                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `npm run gen:types`    | Regenerates `src/shared/openapi.generated.ts` from `docs/openapi-2.3.0.json`           |
| `npm run verify:types` | Fails if that generated file is stale                                                  |
| `npm run gen:docs`     | Regenerates the tables in `docs/REFERENCE.md` from `package.json` + `package.nls.json` |
| `npm run verify:docs`  | Fails if those tables are stale                                                        |
| `npm run verify:links` | Fails on broken links, unknown npm scripts and `opencode.*` settings/commands in prose |

Add a test next to the code you change. A bug fix without a regression test is not a fix. Tests for
protocol changes must cover both valid messages and malformed ones — the runtime guards are a
security boundary, not an implementation detail.

## Documentation map

Three layers, one owner each. Do not copy a fact into a second layer; link to it.

| Layer             | Files                                                                                         | Owns                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Product           | `README.md`, `media/walkthrough-*.md`                                                         | Positioning, install, quick start, feature index, onboarding         |
| Contributor       | `docs/FEATURES.md`, `SPEC.md`, `CONTRIBUTING.md`, other `docs/` pages                         | Detailed behaviour, protocol, API facts, decisions, limits, releases |
| Generated/history | `docs/REFERENCE.md`, `CHANGELOG.md`, `docs/openapi-*.json`, `src/shared/openapi.generated.ts` | Reference tables and release history — never hand-edit               |

Keep `README.md` short: a feature becomes a one-line pointer to the relevant section of
[docs/FEATURES.md](docs/FEATURES.md), with the explanation living there. `docs/REFERENCE.md` contains
two generated blocks delimited by `<!-- BEGIN GENERATED: … -->` comments. Change a command,
keybinding or setting in `package.json` / `package.nls.json`, then run `npm run gen:docs` and commit
the result. The release CI runs `npm run verify:docs` and `npm run verify:links` before publishing.

See [docs/README.md](docs/README.md) for the index of the contributor documentation.

## Before opening a PR

- `npm run verify` passes locally (lint, formatting, typecheck, docs, generated types and all
  deterministic suites).
- `npm run gen:docs` and `npm run gen:types` produce no diff after a manifest or snapshot change.
- `CHANGELOG.md` has a short entry for user-visible changes. Only the recent releases live in the
  file; older ones are in [GitHub Releases](https://github.com/mattiamalonni/chat-for-opencode/releases).
- No credentials, absolute machine paths or generated artifacts are committed.
- CI on push/PR is green on Linux, macOS and Windows; the live contract job is advisory.

## Style

Prettier (`npm run format`) and ESLint (`npm run lint`) define the style. Keep line endings LF;
`.editorconfig` and `.gitattributes` enforce that across platforms. Prefer small services with
explicit dependencies over adding more state to `ChatController`.
