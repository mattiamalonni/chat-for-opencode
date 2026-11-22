# Documentation index

- [README.md](../README.md) — features, settings and commands.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — setup, test matrix and definition of done.
- [SPEC.md](../SPEC.md) — behaviour specification and UI details.
- [PLAN.md](../PLAN.md) — roadmap and delivery status.
- [API_NOTES.md](API_NOTES.md) — the OpenCode v2 endpoints and events this extension relies on.
- [DECISIONS.md](DECISIONS.md) — architecture decisions and why they were made.
- [KNOWN_LIMITS.md](KNOWN_LIMITS.md) — deliberate limits and known rough edges.
- [MANUAL_TEST.md](MANUAL_TEST.md) — manual verification checklist.
- [RELEASING.md](RELEASING.md) — release and marketplace steps.

The generated OpenAPI snapshot lives in [`openapi-2.2.7.json`](openapi-2.2.7.json); the TypeScript
types derived from it (`src/shared/openapi.generated.ts`) are checked in and verified in CI by
`npm run gen:types`.
