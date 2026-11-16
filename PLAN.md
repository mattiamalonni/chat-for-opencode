# Plan

Legend: `[x]` done and verified · `[~]` written, not fully verified · `[ ]` todo

## Phase 0 — Discovery
- [x] opencode installed (v2.2.7)
- [x] Docs read (llms.txt, API, client, web, permissions, attachments)
- [x] Real contract probed from `opencode serve` → docs/API_NOTES.md
- [x] SDK vs HTTP decision → docs/DECISIONS.md

## Phase 1 — Skeleton
- [ ] Scaffolding: package.json, tsconfig strict, esbuild (host + webview), eslint, vitest
- [ ] F5 launch config
- [ ] Server management (spawn, port, health, restart, stop, external endpoint)
- [ ] Commands `opencode.reconnect`, `opencode.newSession`
- [ ] Sidebar webview with input, send prompt, show reply
- Verify: compile + lint + unit tests (server manager vs fake binary, client vs mock)

## Phase 2 — Real chat
- [ ] SSE streaming, markdown + highlighting
- [ ] Collapsible reasoning, generic tool cards
- [ ] Sessions: list/create/switch/resume/delete, persisted across restarts
- [ ] Model/variant + agent selectors from server data
- [ ] Abort
- Verify: reducer + SSE unit tests, mock-server tests, Playwright screenshots

## Phase 3 — Editor integration
- [ ] Auto context (active file + selection) removable
- [ ] `@` file autocomplete; "Add selection to chat" context menu
- [ ] Native diffs; changed-files list
- [ ] Inline permission + question (form) cards
- [ ] Todo list (todowrite)
- Verify: unit tests (patch), UI test, e2e vs real server

## Phase 4 — Polish
- [ ] Error handling with actions
- [ ] a11y, key isolation, IME
- [ ] Settings documented, README, CHANGELOG
- [ ] l10n en/it
- [ ] Integration test (@vscode/test-electron)
- [ ] vsce package

## Phase 5 — Optional
- [ ] `@opencode` chat participant (evaluate)
