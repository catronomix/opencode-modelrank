/**
 * Pure ranking logic for the /modelrank plugin.
 *
 * Ported from codesam88/opencode-models:
 *  - five tracked benchmarks, each normalised to its own 0-100 scale over the
 *    fetched catalog (best model = 100, worst = 0);
 *  - a model's score is the median of the scales it carries, and needs at
 *    least two of them to be ranked at all;
 *  - cost uses a representative coding session rather than a raw $/1M blend,
 *    because agent traffic is mostly cache reads.
 */

export type Provider = "opencode" | "opencode-go"

/** A catalog price multiplier and the `when` conditions that activate it. */
export type Multiplier = { when?: unknown; factor: number }

export type Entry = {
  /** `provider/id` — the key the plugin stores in its exclusion list. */
  key: string
  provider: Provider
  id: string
  name: string
  /** `lab/slug` identity shared by the free/paid/first-party listings. */
  canonical: string
  free: boolean
  /** USD per 1M tokens. */
  input: number
  cacheRead: number
  output: number
  context: number
  /**
   * Peak-hour factor at fetch time. Used only when `multipliers` is absent;
   * otherwise the factor is re-evaluated against the current clock.
   */
  peakFactor: number
  /** Catalog multipliers, kept so the factor can follow the clock. */
  multipliers?: Multiplier[]
  /** Plans whose listing this row represents (same model, same price). */
  plans: Provider[]
  benchmarks: Record<string, number>
}

export type BenchScore = { name: string; value: number }

export type Row = {
  entry: Entry
  /** Tracked benchmarks this model carries, on their 0-100 scales. */
  derived: BenchScore[]
  /** Median of `derived`, or null when fewer than two axes exist. */
  score: number | null
  /** Blended $/1M tokens: 0.7 x input + 0.3 x output. */
  tokenCost: number
  /** Estimated USD for a representative coding session. */
  sessionCost: number
  /** Cache-read price divided by input price. */
  cacheRatio: number
  /** score / sessionCost; Infinity for free models. */
  value: number
}

export const TRACKED = [
  "Terminal-Bench 2.1",
  "Terminal-Bench 4.0",
  "SWE-Bench Verified",
  "SWE-Bench Pro",
  "DeepSWE 1.1",
] as const

export type Tracked = (typeof TRACKED)[number]

/** Benchmarks the user can focus the ranking on, in display order. */
export const FOCUSES = ["overall", ...TRACKED] as const
export type Focus = (typeof FOCUSES)[number]

export const SORTS = ["value", "score", "cheap", "cache", "context", "name"] as const
export type Sort = (typeof SORTS)[number]

export const SORT_LABEL: Record<Sort, string> = {
  value: "score per $",
  score: "benchmark score",
  cheap: "$/1M blended",
  cache: "cache ratio",
  context: "context window",
  name: "name",
}

export const FOCUS_LABEL: Record<Focus, string> = {
  overall: "overall (median)",
  "Terminal-Bench 2.1": "Terminal-Bench 2.1",
  "Terminal-Bench 4.0": "Terminal-Bench 4.0",
  "SWE-Bench Verified": "SWE-bench Verified",
  "SWE-Bench Pro": "SWE-bench Pro",
  "DeepSWE 1.1": "DeepSWE 1.1",
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

/** `"22:00"` -> minutes since midnight. */
function parseClock(text: unknown): number | undefined {
  const match = typeof text === "string" ? /^(\d{1,2}):(\d{2})$/.exec(text) : null
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined
}

const warned = new Set<string>()

/**
 * Matcher for the `when` grammar OpenCode uses on price multipliers.
 *
 * An unrecognised predicate fails closed: the condition is false, and the key
 * is reported once, so a catalog change cannot quietly apply a wrong price.
 */
export function matchesWhen(when: unknown, now: Date): boolean {
  if (!when || typeof when !== "object") return false
  const spec = when as Record<string, unknown>
  for (const [key, value] of Object.entries(spec)) {
    if (key === "any") {
      if (!Array.isArray(value) || !value.some((item) => matchesWhen(item, now))) return false
      continue
    }
    if (key === "all") {
      if (!Array.isArray(value) || !value.every((item) => matchesWhen(item, now))) return false
      continue
    }
    if (key === "utc_days") {
      const days = (value as { in?: string[] })?.in
      if (!Array.isArray(days) || !days.includes(WEEKDAYS[now.getUTCDay()])) return false
      continue
    }
    if (key === "utc_hours") {
      const rule = value as { gte?: string; lt?: string }
      const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
      const low = parseClock(rule?.gte)
      const high = parseClock(rule?.lt)
      // A window that ends before it starts wraps midnight (22:00-04:00).
      if (low !== undefined && high !== undefined && low > high) {
        if (minutes < low && minutes >= high) return false
        continue
      }
      if (low !== undefined && minutes < low) return false
      if (high !== undefined && minutes >= high) return false
      continue
    }
    if (!warned.has(key)) {
      warned.add(key)
      console.warn(`[modelrank] unknown price condition "${key}" — treated as false`)
    }
    return false
  }
  return true
}

/** First multiplier whose conditions hold right now, else `fallback`. */
export function multiplierFactor(multipliers: readonly Multiplier[] | undefined, now: Date, fallback = 1): number {
  for (const multiplier of multipliers ?? []) {
    if (matchesWhen(multiplier.when, now)) return multiplier.factor
  }
  return fallback
}

/** Peak factor for `entry` at `now`, following the clock when multipliers are known. */
export function peakFactorAt(entry: Entry, now: Date): number {
  if (!entry.multipliers?.length) return entry.peakFactor
  return multiplierFactor(entry.multipliers, now)
}

/** Session assumptions, matching opencode-models' default mix. */
const SESSION = { input: 400_000, cacheShare: 0.8, output: 50_000 }

/** A benchmark every model scored the same on says nothing. */
const NEUTRAL = 50

/** Two independent axes is the smallest evidence worth ranking on. */
const MIN_AXES = 2

/** `Terminal-Bench` + version -> `Terminal-Bench <version>`; everything else by name. */
export function canonicalBenchmark(name: string, version?: string): string | undefined {
  if (name === "Terminal-Bench") {
    if (version === "2.1") return "Terminal-Bench 2.1"
    if (version === "4.0") return "Terminal-Bench 4.0"
    return undefined
  }
  if (name === "Terminal-Bench 2.1" || name === "Terminal-Bench 4.0") return name
  if (name === "SWE-Bench Verified" || name === "SWE-Bench Pro") return name
  if (name === "DeepSWE" && version === "1.1") return "DeepSWE 1.1"
  if (name === "DeepSWE 1.1") return name
  return undefined
}

/** Best (highest) score per tracked benchmark in a record. */
export function pickBenchmarks(
  benchmarks: ReadonlyArray<{ name: string; score?: unknown; version?: string }>,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const bench of benchmarks) {
    if (typeof bench.score !== "number" || !Number.isFinite(bench.score)) continue
    const key = canonicalBenchmark(bench.name, bench.version)
    if (!key) continue
    if (out[key] === undefined || bench.score > out[key]) out[key] = bench.score
  }
  return out
}

/** `(lowest, best)` raw range of every tracked benchmark across the catalog. */
export function scales(entries: readonly Entry[]): Map<string, [number, number]> {
  const values = new Map<string, number[]>()
  for (const entry of entries) {
    for (const [name, value] of Object.entries(entry.benchmarks)) {
      const list = values.get(name)
      if (list) list.push(value)
      else values.set(name, [value])
    }
  }
  const out = new Map<string, [number, number]>()
  for (const [name, list] of values) out.set(name, [Math.min(...list), Math.max(...list)])
  return out
}

export function normalise(score: number, bounds: [number, number]): number {
  const [floor, ceiling] = bounds
  if (ceiling <= floor) return NEUTRAL
  return Math.min(100, Math.max(0, ((score - floor) / (ceiling - floor)) * 100))
}

export function median(values: readonly number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function buildRows(entries: readonly Entry[], table: Map<string, [number, number]>, now: Date = new Date()): Row[] {
  return entries.map((entry) => {
    const derived: BenchScore[] = []
    for (const name of TRACKED) {
      const raw = entry.benchmarks[name]
      if (raw === undefined) continue
      const bounds = table.get(name)
      if (!bounds || bounds[1] <= bounds[0]) continue
      derived.push({ name, value: normalise(raw, bounds) })
    }
    const score = derived.length >= MIN_AXES ? median(derived.map((d) => d.value)) : null
    const peak = peakFactorAt(entry, now)
    const cacheRead = entry.cacheRead * peak
    const input = entry.input * peak
    const output = entry.output * peak
    const tokenCost = 0.7 * input + 0.3 * output
    const fresh = SESSION.input * (1 - SESSION.cacheShare)
    const cached = SESSION.input * SESSION.cacheShare
    const sessionCost = (fresh * input + cached * cacheRead + SESSION.output * output) / 1_000_000
    const cacheRatio = input > 0 ? cacheRead / input : 0
    const value = score === null ? 0 : sessionCost === 0 ? Number.POSITIVE_INFINITY : score / sessionCost
    return { entry, derived, score, tokenCost, sessionCost, cacheRatio, value }
  })
}

/** Score shown/ranked on: the focused benchmark when one is chosen. */
export function focusScore(row: Row, focus: Focus): number | null {
  if (focus === "overall") return row.score
  return row.derived.find((d) => d.name === focus)?.value ?? null
}

const byName = (a: Row, b: Row) => a.entry.name.localeCompare(b.entry.name)

/** Sorts that order on a benchmark score; the rest order every row on their own key. */
const SCORE_SORTS = new Set<Sort>(["value", "score"])

export function rank(rows: readonly Row[], sort: Sort, focus: Focus): Row[] {
  const primary = (row: Row) => focusScore(row, focus)
  // Only a score-dependent sort treats unranked rows as a separate bucket; for
  // price/cache/context/name they are ordinary rows ordered by that key.
  const needsScore = SCORE_SORTS.has(sort)
  const missing = (row: Row) => (primary(row) === null ? 1 : 0)
  const list = [...rows]
  list.sort((a, b) => {
    if (needsScore && missing(a) !== missing(b)) return missing(a) - missing(b)
    switch (sort) {
      case "value": {
        if (a.value !== b.value) return b.value - a.value
        return (primary(b) ?? 0) - (primary(a) ?? 0) || byName(a, b)
      }
      case "score":
        return (primary(b) ?? 0) - (primary(a) ?? 0) || byName(a, b)
      case "cheap":
        if (a.sessionCost !== b.sessionCost) return a.sessionCost - b.sessionCost
        return (primary(b) ?? 0) - (primary(a) ?? 0) || byName(a, b)
      case "cache":
        if (a.cacheRatio !== b.cacheRatio) return a.cacheRatio - b.cacheRatio
        return (primary(b) ?? 0) - (primary(a) ?? 0) || byName(a, b)
      case "context":
        if (a.entry.context !== b.entry.context) return b.entry.context - a.entry.context
        return (primary(b) ?? 0) - (primary(a) ?? 0) || byName(a, b)
      case "name":
      default:
        return byName(a, b)
    }
  })
  return list
}

export function providerLabel(provider: Provider): string {
  return provider === "opencode-go" ? "Go" : "Zen"
}

/** "Zen" / "Go" / "Zen+Go" */
export function plansLabel(entry: Entry): string {
  const plans = entry.plans ?? [entry.provider]
  return [...new Set(plans)].map(providerLabel).join("+")
}

/** Whether this row is offered on `plan`; an untagged entry belongs to its own provider. */
export function isOnPlan(entry: Entry, plan: Provider): boolean {
  return (entry.plans ?? [entry.provider]).includes(plan)
}

/**
 * One row per model/price/context identity: a model offered by both plans at
 * the same price is one comparison row, not two. `plans` records where it is
 * available.
 */
export function collapse(entries: readonly Entry[]): Entry[] {
  const seen = new Map<string, Entry>()
  const order: string[] = []
  for (const entry of entries) {
    const identity = [entry.canonical, entry.input, entry.cacheRead, entry.output, entry.context].join("|")
    const existing = seen.get(identity)
    if (!existing) {
      const copy: Entry = { ...entry, plans: [...new Set([...(entry.plans ?? []), entry.provider])] }
      seen.set(identity, copy)
      order.push(identity)
      continue
    }
    existing.plans = [...new Set([...existing.plans, ...(entry.plans ?? []), entry.provider])]
  }
  return order.map((identity) => seen.get(identity)!)
}

export function money(value: number): string {
  // A NaN price is a bug upstream; never let it read as a real "free".
  if (Number.isNaN(value)) return "n/a"
  if (value === 0) return "free"
  if (!Number.isFinite(value)) return "free"
  if (value < 0.1) return `$${value.toFixed(3)}`
  if (value < 10) return `$${value.toFixed(2)}`
  return `$${value.toFixed(0)}`
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return ""
  if (text.length <= width) return text
  if (width === 1) return "…"
  return `${text.slice(0, width - 1)}…`
}
