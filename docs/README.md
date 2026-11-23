# Documentation index

Start with [README.md](../README.md) for users. The pages below are for contributors. Each file has
one job, so look for a fact in its owner rather than in several places; the full map is in
[CONTRIBUTING.md](../CONTRIBUTING.md#documentation-map).

## Behaviour and design

- [FEATURES.md](FEATURES.md) — detailed feature behaviour; the short index lives in
  [README.md](../README.md#features).
- [SPEC.md](../SPEC.md) — behaviour specification, architecture, webview protocol and security.
- [DECISIONS.md](DECISIONS.md) — architecture decisions and why they were made.
- [API_NOTES.md](API_NOTES.md) — the OpenCode v2 endpoints and events this extension relies on.
- [KNOWN_LIMITS.md](KNOWN_LIMITS.md) — deliberate limits, architectural debt and unverified areas.
- [MANUAL_TEST.md](MANUAL_TEST.md) — checklist for what automation still cannot verify.

## Process

- [CONTRIBUTING.md](../CONTRIBUTING.md) — setup, the single test-command matrix and definition of done.
- [RELEASING.md](RELEASING.md) — release and Marketplace steps.
- [CHANGELOG.md](../CHANGELOG.md) — the recent releases only; older notes live in
  [GitHub Releases](https://github.com/mattiamalonni/chat-for-opencode/releases).

## Product surfaces

The in-product walkthrough (**Help → Welcome → Get started with OpenCode**) is contributed by
`package.json` and rendered from four short Markdown pages:
[trust](../media/walkthrough-trust.md), [install](../media/walkthrough-install.md),
[provider](../media/walkthrough-provider.md) and [chat](../media/walkthrough-chat.md).

## Screenshots

`npm run test:ui` writes the full set of numbered PNGs to `test/ui/screenshots/`; CI uploads them as
the `ui-screenshots` artifact. A curated subset lives in `docs/images/`, renamed without the numeric
prefix. These copies are committed, not produced at build time: after a UI change,
regenerate the set and refresh the curated images deliberately.

The README hero (`docs/images/hero.png`) is a full-window screenshot of the real extension running in
VS Code against the mock `opencode serve`. `npm run gen:hero` launches VS Code with the development
extension and a mock server, sends a prompt through the real webview, opens the `/` command picker and
captures the whole window over CDP (`test/integration/suite/hero.test.ts`). No UI chrome is mocked, so
the image stays accurate when the interface changes.

## Generated artefacts

- [REFERENCE.md](REFERENCE.md) — every command, default key and setting, plus in-chat keys.
  Generated from `package.json` + `package.nls.json` by `npm run gen:docs` and checked by
  `npm run verify:docs`.

The supported OpenAPI snapshot is [`openapi-2.3.0.json`](openapi-2.3.0.json); the TypeScript types
derived from it (`src/shared/openapi.generated.ts`) are checked in and verified in CI by
`npm run gen:types`. [`openapi-2.2.7.json`](openapi-2.2.7.json) is kept as the snapshot the recorded
SSE fixtures were captured against.
