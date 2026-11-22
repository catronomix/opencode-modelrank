/**
 * Network + cache layer.
 *
 * Everything comes from OpenCode's own public endpoints:
 *  - `opencode.ai/zen/v1/models`             Zen (pay-as-you-go) catalog + prices
 *  - `opencode.ai/inference/go/v1/models`    Go (subscription) catalog + prices
 *  - `opencode.ai/data/<lab>/<slug>.json`    benchmark records, linked by `canonical_id`
 *
 * The snapshot is cached on disk and refreshed on demand, so the sidebar can
 * paint immediately at startup and stay usable offline.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { pickBenchmarks, collapse, multiplierFactor, type Entry, type Multiplier, type Provider } from "./logic.ts"

const ZEN_URL = "https://opencode.ai/zen/v1/models"
const GO_URL = "https://opencode.ai/inference/go/v1/models"
const DATA_URL = "https://opencode.ai/data"
const TIMEOUT_MS = 20_000
const CONCURRENCY = 8
/** A snapshot older than this is refreshed in the background. */
export const MAX_AGE_MS = 6 * 60 * 60 * 1000
/** Bumping this invalidates every cache written by an older shape. */
export const SNAPSHOT_SCHEMA = 1

type ListedModel = {
  id: string
  name?: string
  canonical_id?: string
  limit?: { context?: number }
  cost?: {
    text?: {
      input?: { price?: number; cache?: { read?: number } }
      output?: { price?: number }
    }
    multipliers?: Array<{ when?: unknown; factor?: number }>
  }
}

type ModelRecord = {
  model?: { benchmarks?: Array<{ name: string; score?: unknown; version?: string }> }
}

export type Snapshot = {
  /** Shape marker; a cache without the current value is discarded. */
  schema: number
  at: number
  entries: Entry[]
  /** Canonical ids with no benchmark record, or that failed to fetch. */
  missing: string[]
}

export function cacheFile(): string {
  const dir = process.env.OPENCODE_MODELRANK_DATA ?? join(homedir(), ".cache", "opencode-modelrank")
  return join(dir, "snapshot.json")
}

async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    headers: { "user-agent": "opencode-modelrank" },
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
  return (await response.json()) as T
}

/** Every numeric multiplier, in catalog order, ready to re-evaluate against the clock. */
function multipliersOf(model: ListedModel): Multiplier[] {
  return (model.cost?.multipliers ?? [])
    .filter((multiplier) => typeof multiplier.factor === "number")
    .map((multiplier) => ({ when: multiplier.when, factor: multiplier.factor as number }))
}

function toEntry(provider: Provider, model: ListedModel, benchmarks: Record<string, number>, now: Date): Entry {
  const input = model.cost?.text?.input?.price ?? 0
  const cacheRead = model.cost?.text?.input?.cache?.read ?? 0
  const output = model.cost?.text?.output?.price ?? 0
  const canonical = model.canonical_id ?? model.id
  const multipliers = multipliersOf(model)
  return {
    key: `${provider}/${model.id}`,
    provider,
    id: model.id,
    name: model.name ?? model.id,
    canonical,
    free: input === 0 && output === 0,
    input,
    cacheRead,
    output,
    context: model.limit?.context ?? 0,
    peakFactor: multiplierFactor(multipliers, now),
    multipliers,
    plans: [provider],
    benchmarks,
  }
}

async function mapPool<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      out[index] = await run(items[index])
    }
  })
  await Promise.all(workers)
  return out
}

/** Fetch live catalogs + benchmark records and build a fresh snapshot. */
export async function fetchSnapshot(signal?: AbortSignal): Promise<Snapshot> {
  const now = new Date()
  const [zen, go] = await Promise.all([getJSON<{ data: ListedModel[] }>(ZEN_URL, signal), getJSON<{ data: ListedModel[] }>(GO_URL, signal)])
  const listed: Array<[Provider, ListedModel]> = [
    ...(zen.data ?? []).map((model) => ["opencode", model] as [Provider, ListedModel]),
    ...(go.data ?? []).map((model) => ["opencode-go", model] as [Provider, ListedModel]),
  ]
  const canonicals = [...new Set(listed.map(([, model]) => model.canonical_id ?? model.id))]
  const missing: string[] = []
  const records = await mapPool(canonicals, CONCURRENCY, async (canonical) => {
    try {
      const record = await getJSON<ModelRecord>(`${DATA_URL}/${canonical}.json`, signal)
      return [canonical, pickBenchmarks(record.model?.benchmarks ?? [])] as const
    } catch {
      missing.push(canonical)
      return [canonical, {}] as const
    }
  })
  const byCanonical = new Map(records)
  const entries = listed.map(([provider, model]) =>
    toEntry(provider, model, byCanonical.get(model.canonical_id ?? model.id) ?? {}, now),
  )
  return { schema: SNAPSHOT_SCHEMA, at: Date.now(), entries: collapse(entries), missing }
}

const NUMERIC_ENTRY_FIELDS = ["input", "cacheRead", "output", "context", "peakFactor"] as const

/** A cached row is only usable if every field the renderer reads has its type. */
function isEntry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false
  const entry = value as Record<string, unknown>
  if (typeof entry.key !== "string" || typeof entry.id !== "string" || typeof entry.name !== "string") return false
  if (entry.provider !== "opencode" && entry.provider !== "opencode-go") return false
  if (typeof entry.canonical !== "string" || typeof entry.free !== "boolean") return false
  if (!Array.isArray(entry.plans)) return false
  if (!entry.benchmarks || typeof entry.benchmarks !== "object") return false
  if (entry.multipliers !== undefined) {
    if (!Array.isArray(entry.multipliers)) return false
    // A hand-edited cache must not push a non-finite factor into every price.
    if (!entry.multipliers.every((multiplier) => Number.isFinite((multiplier as Multiplier | undefined)?.factor))) return false
  }
  return NUMERIC_ENTRY_FIELDS.every((field) => Number.isFinite(entry[field] as number))
}

export async function readCache(): Promise<Snapshot | undefined> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile(), "utf8")) as Partial<Snapshot> | undefined
    if (parsed?.schema !== SNAPSHOT_SCHEMA) return undefined
    if (!Number.isFinite(parsed.at)) return undefined
    if (!Array.isArray(parsed.entries) || !parsed.entries.every(isEntry)) return undefined
    if (!Array.isArray(parsed.missing)) return undefined
    return parsed as Snapshot
  } catch {
    return undefined
  }
}

export async function writeCache(snapshot: Snapshot): Promise<void> {
  try {
    const file = cacheFile()
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(snapshot))
  } catch {
    // A read-only home directory must not break the sidebar; the in-memory
    // snapshot is still correct for this session.
  }
}

/**
 * Cached snapshot when it exists, a live fetch when it does not. `force`
 * always refetches. `stale` is true when the returned snapshot is older than
 * `MAX_AGE_MS`, which the caller may use to refresh in the background.
 */
export async function loadSnapshot(options: { force?: boolean } = {}): Promise<{ snapshot: Snapshot; stale: boolean; cached: boolean }> {
  const cached = options.force ? undefined : await readCache()
  if (cached) return { snapshot: cached, stale: Date.now() - cached.at > MAX_AGE_MS, cached: true }
  const snapshot = await fetchSnapshot()
  await writeCache(snapshot)
  return { snapshot, stale: false, cached: false }
}
