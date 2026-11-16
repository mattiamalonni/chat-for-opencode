# Plan

Legend: `[x]` done and verified by an automated test or probe · `[~]` written, only partially verified · `[ ]` not done

## Phase 0 — Discovery
- [x] opencode installed (v2.2.7)
- [x] Docs read (llms.txt, API, client, web, permissions, attachments)
- [x] Real contract probed from `opencode serve` → docs/API_NOTES.md (+ `openapi-2.2.7.json`, recorded SSE fixtures)
- [x] SDK vs HTTP decision → docs/DECISIONS.md (D1)

## Phase 1 — Skeleton
- [x] package.json, tsconfig strict, esbuild (host + webview), eslint, vitest
- [x] F5 launch config (`.vscode/launch.json`); extension launch exercised via test-electron
- [x] Server management: spawn, dynamic port, health, auto-restart, stop, external endpoint (unit + integration)
- [x] Commands `opencode.reconnect`, `opencode.newSession` (integration)
- [x] Sidebar webview, send prompt, show reply (UI + integration)

## Phase 2 — Real chat
- [x] SSE streaming, reconnect + resync, markdown + highlighting (unit, UI, e2e)
- [x] Collapsible reasoning, generic tool cards (UI with real fixtures)
- [x] Sessions: list/create/switch/resume/delete, persisted per folder (integration, UI)
- [x] Model/variant + agent selectors from server data (UI, integration)
- [x] Abort (UI, integration, e2e)

## Phase 3 — Editor integration
- [x] Auto context (active file + selection), removable (UI, integration)
- [x] `@` file autocomplete; "Add Selection to Chat" / "Add File to Chat" (UI, integration)
- [x] Native diffs (proposed + applied); changed-files list (unit patch, integration, e2e)
- [x] Inline permission + question cards, never auto-approved (UI, integration, e2e)
- [x] Todo list from `todowrite` (unit + UI with real fixture)

## Phase 4 — Polish
- [x] Error handling with actions (UI, unit)
- [~] a11y, key isolation, IME — automated in Chromium with synthetic events; no real IME / screen reader
- [x] Settings documented, README, CHANGELOG
- [x] l10n en/it (unit completeness test, UI)
- [x] Integration tests on VS Code stable (1.146) and minimum 1.99.3
- [x] `vsce package`

## Phase 5 — Optional
- [x] Evaluated `@opencode` chat participant → skipped (API deprecated, see KNOWN_LIMITS)

See docs/KNOWN_LIMITS.md for what could not be verified.
