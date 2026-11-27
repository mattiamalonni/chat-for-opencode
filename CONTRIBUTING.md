# Contributing

Thanks for helping improve chat-for-opencode. This extension hosts OpenCode in-process through
`@opencode/sdk`, streams its events into a VS Code webview, and keeps the two sides in sync — so most
bugs are about a boundary (host ↔ SDK, host ↔ webview, or an async race). The checks below exist to
catch those.

## Quick start

```sh
node --version   # see .nvmrc
npm ci
npm run compile  # typecheck + esbuild bundles
npm test         # lint, format, typecheck + unit, UI and integration (fast local loop)
npm run verify   # the full CI gate, including audit, coverage floors and the production smoke test
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host. The chat opens in the
secondary side bar. OpenCode 2.4.1 is bundled; configure a provider to talk to a real model, while
most work only needs the deterministic mock server used by the tests. Install the Playwright browser
with `npx playwright install chromium`; integration tests download VS Code into `.vscode-test/`
(`VSCODE_TEST_VERSION=1.134.0` exercises the minimum supported version — the SDK needs Node 24).

## Where things live

| Area                                        | Entry point                                                    |
| ------------------------------------------- | -------------------------------------------------------------- |
| Extension activation and composition root   | `src/extension.ts`                                             |
| Commands, status bars, auth CLI parsing     | `src/commands.ts`, `src/status/`, `src/auth/`                  |
| Chat orchestration and command dispatch     | `src/chat/controller.ts` + `src/chat/services/`                |
| Turn state (status, generation, local idle) | `src/chat/executionState.ts`                                   |
| Embedded host and remote endpoint           | `src/server/server.ts`, `src/sdk/`                             |
| Generated-client facade, event stream       | `src/client/http.ts`, `src/client/sse.ts`                      |
| Picker, paging, search                      | `src/chat/sessionListService.ts`                               |
| Webview UI and reducer                      | `src/webview/` (App + view modules), `src/shared/chatReducer/` |
| Protocol and runtime guards                 | `src/shared/protocol.ts`, `src/shared/protocolGuards.ts`       |

Architecture notes and API facts: [docs/README.md](docs/README.md).

## Tests: which suite for what

This is the single list of test commands. Other docs link here instead of repeating it.

### Deterministic — run locally, enforced at release

| Command                             | Covers                                 | Notes                                                                         |
| ----------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run test:unit`                 | Pure/host logic with mocks             | Fastest feedback; use for reducers, services, guards, parsers                 |
| `npm run test:ui`                   | Webview in Chromium                    | Uses the recorded 2.2.7 SSE fixtures; no server or provider                   |
| `npm run test:integration`          | Extension inside VS Code + mock server | Needs a downloaded VS Code (`.vscode-test/`), no credentials                  |
| `npm run test:coverage`             | Unit coverage                          | Thresholds in `vitest.config.mts`                                             |
| `npm run test:coverage:ui`          | UI suite + webview line coverage       | Maps Chromium V8 ranges through the source map; gate via `OC_UI_COVERAGE_MIN` |
| `npm run test:ui:prod`              | Minified production bundle             | Smoke test for the artefact that actually ships                               |
| `npm test`                          | The three deterministic suites         | `pretest` also runs lint, formatting and typecheck                            |
| `npm run verify`                    | Everything above plus audit            | The full local equivalent of CI                                               |
| `npm run test:integration:embedded` | Embedded-host code path                | Uses an injected bridge over the mock API                                     |

### Provider-backed — opt-in, needs a provider

| Command                             | Covers                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `npm run test:e2e`                  | Live OpenCode SDK host and contract; advisory, manual CI dispatch only                 |
| `npm run test:integration:e2e`      | Real webview inside VS Code, CDP clicks against the mock API                           |
| `npm run test:integration:real`     | Extension inside VS Code with the embedded SDK, driven through its message API         |
| `npm run test:integration:real:e2e` | Real webview clicks plus a real model: types a prompt and waits for the streamed reply |

These need a provider configured; see [MANUAL_TEST.md](docs/MANUAL_TEST.md) for what they leave to a
human.

### Generated artefacts and documentation

| Command                       | Checks                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `npm run gen:types`           | Regenerates `src/shared/openapi.generated.ts` from `docs/openapi-2.4.1.json`                         |
| `npm run verify:types`        | Fails if that generated file is stale                                                                |
| `npm run gen:docs`            | Regenerates the tables in `docs/REFERENCE.md` from `package.json` + `package.nls.json`               |
| `npm run verify:docs`         | Fails if those tables are stale                                                                      |
| `npm run gen:vscodeignore`    | Regenerates the VSIX native-module allow-list from `scripts/external-modules.mjs`                    |
| `npm run verify:vscodeignore` | Fails if that allow-list is stale                                                                    |
| `npm run verify:links`        | Fails on broken links, unknown npm scripts and `opencode.*` settings/commands in prose               |
| `npm run verify:vsix`         | `<file.vsix> [target]`: fails if a VSIX lacks its target's native binaries or ships foreign ones     |
| `npm run smoke:host`          | `<file.vsix> [--no-pty]`: starts the embedded OpenCode host and a pty from the package               |
| `npm run demo:record`         | Rebuilds the webview and re-records the README hero `docs/images/demo.gif` (scripted, deterministic) |

Add a test next to the code you change. A bug fix without a regression test is not a fix. Tests for
protocol changes must cover both valid messages and malformed ones — the runtime guards are a
security boundary, not an implementation detail.

## Documentation map

Three layers, one owner each. Do not copy a fact into a second layer; link to it.

| Layer             | Files                                                                                             | Owns                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Product           | `README.md`, `media/walkthrough-*.md`                                                             | Positioning, install, quick start, feature index, onboarding         |
| Contributor       | `docs/FEATURES.md`, `SPEC.md`, `CONTRIBUTING.md`, other `docs/` pages                             | Detailed behaviour, protocol, API facts, decisions, limits, releases |
| Generated/history | `docs/REFERENCE.md`, `CHANGELOG.md`, `docs/openapi-2.4.1.json`, `src/shared/openapi.generated.ts` | Reference tables and release history — never hand-edit               |

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

Oxfmt (`npm run format`) and Oxlint (`npm run lint`) define the style. Their options live in
`oxfmt.config.ts` and `oxlint.config.ts`; use the Node version from `.nvmrc`, which is recent enough
to load those TypeScript configs. Keep line endings LF; `.editorconfig` and `.gitattributes` enforce
that across platforms. Prefer small services with explicit dependencies over adding more state to
`ChatController`.
