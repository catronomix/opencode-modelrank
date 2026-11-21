# opencode-ocmodels

An OpenCode V2 plugin that ranks **OpenCode Zen / Go** models by benchmark score
against real per-token prices — a `/ocmodels` menu to choose which models and
which sort order, and a live comparison in the sidebar.

It is a TypeScript re-make of [codesam88/opencode-models](https://github.com/codesam88/opencode-models)
(the `ocm` Python CLI), keeping its ranking rules:

- five tracked benchmarks — **Terminal-Bench 2.1**, **Terminal-Bench 4.0**,
  **SWE-Bench Verified**, **SWE-Bench Pro**, **DeepSWE 1.1**;
- each benchmark is normalised to its own 0–100 scale over the fetched
  catalog, and a model's score is the **median** of the scales it carries;
- a model with fewer than two tracked benchmarks is **unranked**, not last;
- cost uses a representative coding session (400k input, 80% cache reads, 50k
  output) instead of a raw $/1M blend, because agent traffic is mostly cache
  reads.

## Install

Add the package directory (or the published package name) to the TUI plugin
list in `cli.json`, then restart OpenCode:

```json title="~/.config/opencode/cli.json"
{
  "plugins": ["C:/GITHUB/opencode-ocmodels"]
}
```

Alternatively, with a server part present, the same entry works in
`opencode.jsonc`'s `plugins` array. The plugin declares both parts, so either
loads the sidebar and the command.

The sidebar must be visible for the comparison panel to appear:

```jsonc
// cli.json
"session": { "sidebar": "show" }
```

## Use

`/ocmodels` (alias `/ocm`, also in the command palette as **Model comparison
(score vs price)**) opens a menu:

| Entry | What it does |
|---|---|
| **Sort** | `score per $`, `benchmark score`, `$/1M blended`, `cache ratio`, `context window`, `name` |
| **Benchmark focus** | overall median, or rank on one of the five tracked benchmarks |
| **Models included** | toggle rows on/off; quick actions for all / none / free / Go only / Zen only |
| **Sidebar rows** | 4, 6, 8, 12, 16 or 24 rows |
| **Refresh data** | refetch the Zen/Go catalogs and benchmark records |

Settings and the exclusion list persist in plugin storage across restarts.

The sidebar panel shows rank, model, focused score and blended $/1M. The model
you have selected is marked `▸`. A row appears once per model/price/context:
a model offered by both plans at the same price is a single row.

## Data

Everything comes from OpenCode's own public endpoints:

| Source | Used for |
|---|---|
| `opencode.ai/zen/v1/models` | Zen catalog, prices, context limits, `canonical_id` |
| `opencode.ai/inference/go/v1/models` | Go catalog, prices, peak-hour multipliers |
| `opencode.ai/data/<lab>/<slug>.json` | benchmark records for the `canonical_id` |

Results are cached at `~/.cache/opencode-ocmodels/snapshot.json`
(`OPENCODE_OCMODELS_DATA` overrides the directory) and refreshed in the
background after 6 hours, or on demand from the menu. Models with no
benchmark record still appear with prices and rank last when a score is
required.

## Development

```sh
npm install
npm test              # ranking logic, node:test
npx tsc --noEmit      # typecheck against the installed plugin SDK
node scripts/inspect.ts   # live check of coverage + top rows per view
```

## Attribution

Ranking semantics and benchmark selection are ported from
`opencode-models` by codesam (MIT). Benchmark numbers are taken from
OpenCode's model catalog, which cites each run's source page.
