# opencode-modelrank

OpenCode plugin: rank Zen/Go models by benchmark score and real per-token price, with a /modelrank menu and a sidebar comparison.

## Layout

- `src/index.ts` — server part
- `src/tui.tsx` — TUI part
- `src/logic.ts` — shared logic
- `src/data.ts` — data
- `test/` — tests
- `scripts/inspect.ts` — inspection script

## Commands

- test: `npm test`
- typecheck: `npm run typecheck`
- build: `npm run build`

## Plugin IDs

- server: `opencode-modelrank`
- TUI: `modelrank.tui`

## Publishing

Standard shared guide: `C:\GITHUB\PUBLISH-GUIDE.md`. `dist/` is gitignored and built by `prepack`. README install text stays version-agnostic.