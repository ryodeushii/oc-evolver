# Release

## Definition of done

The plugin is ready to ship when all of the following are true:

- contract aligned: `package.json`, `eval/runtime-contract.json`, and the documented OpenCode version all match
- local fast gates green
- regular eval batch green
- installed-mode autonomous proof green
- manual local verification completed against the pinned runtime

## Release checklist

1. `bun install`
2. `bun run typecheck`
3. `bun run test:unit`
4. `bun run scripts/check-runtime-contract.ts`
5. `bun run eval:pr`
6. `bun run eval:installed-autonomous`
7. Confirm `README.md` and `docs/evaluation.md` still describe the same manual local verification model used above.

## Optional helper sweep

- `bun run eval:all`
- `bun run eval:installed-smoke`
- Use this only as an extra local helper sweep when the OpenCode runtime is behaving consistently enough to complete the broader batch.

## Runtime pins

- Bun `1.3.13`
- `opencode-ai@1.14.31`

## Notes

- This repo does not rely on committed GitHub CI workflow runners for release proof.
- The authoritative proof model is manual local verification with the commands above.
