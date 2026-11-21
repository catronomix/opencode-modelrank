import assert from "node:assert/strict"
import test from "node:test"

import {
  buildRows,
  canonicalBenchmark,
  focusScore,
  matchesWhen,
  median,
  money,
  normalise,
  peakFactorAt,
  pickBenchmarks,
  rank,
  scales,
  type Entry,
} from "../src/logic.ts"

const entry = (over: Partial<Entry>): Entry => ({
  key: "opencode/x",
  provider: "opencode",
  id: "x",
  name: "X",
  canonical: "lab/x",
  free: false,
  input: 1,
  cacheRead: 0.1,
  output: 5,
  context: 200_000,
  peakFactor: 1,
  plans: ["opencode"],
  benchmarks: {},
  ...over,
})

test("benchmark names fold to the five tracked axes", () => {
  assert.equal(canonicalBenchmark("Terminal-Bench", "2.1"), "Terminal-Bench 2.1")
  assert.equal(canonicalBenchmark("Terminal-Bench", "4.0"), "Terminal-Bench 4.0")
  assert.equal(canonicalBenchmark("Terminal-Bench", "3.0"), undefined)
  assert.equal(canonicalBenchmark("Terminal-Bench Science", "0.1"), undefined)
  assert.equal(canonicalBenchmark("SWE-Bench Verified"), "SWE-Bench Verified")
  assert.equal(canonicalBenchmark("SWE-Bench Multilingual"), undefined)
  assert.equal(canonicalBenchmark("DeepSWE", "1.1"), "DeepSWE 1.1")
})

test("pickBenchmarks keeps the best run per axis", () => {
  const picked = pickBenchmarks([
    { name: "Terminal-Bench", score: 70, version: "2.1" },
    { name: "Terminal-Bench", score: 74, version: "2.1" },
    { name: "Terminal-Bench", score: 30, version: "3.0" },
    { name: "SWE-Bench Verified", score: 81 },
  ])
  assert.deepEqual(picked, { "Terminal-Bench 2.1": 74, "SWE-Bench Verified": 81 })
})

test("normalise is linear and clamped", () => {
  assert.equal(normalise(50, [0, 100]), 50)
  assert.equal(normalise(-5, [0, 100]), 0)
  assert.equal(normalise(150, [0, 100]), 100)
  assert.equal(normalise(5, [5, 5]), 50)
})

test("median handles odd and even counts", () => {
  assert.equal(median([1, 3, 2]), 2)
  assert.equal(median([1, 2, 3, 4]), 2.5)
})

test("a score needs two axes", () => {
  const catalog = [
    entry({ key: "a", name: "A", benchmarks: { "SWE-Bench Verified": 90, "Terminal-Bench 2.1": 90 } }),
    entry({ key: "b", name: "B", benchmarks: { "SWE-Bench Verified": 50, "Terminal-Bench 2.1": 40 } }),
    entry({ key: "c", name: "C", benchmarks: { "SWE-Bench Verified": 20 } }),
  ]
  const rows = buildRows(catalog, scales(catalog))
  const byKey = new Map(rows.map((row) => [row.entry.key, row]))
  assert.equal(byKey.get("c")?.score, null)
  assert.equal(byKey.get("a")?.score, 100)
  // B sits at (50-20)/(90-20) on SWE and at the floor of Terminal-Bench
  assert.equal(byKey.get("b")?.score, (42.857142857142854 + 0) / 2)
})

test("value ranking puts strong cheap models first and free on top", () => {
  const catalog = [
    entry({ key: "pricey", name: "Pricey", input: 10, cacheRead: 1, output: 50, benchmarks: { "SWE-Bench Verified": 90, "Terminal-Bench 2.1": 88 } }),
    entry({ key: "cheap", name: "Cheap", input: 0.2, cacheRead: 0.02, output: 0.8, benchmarks: { "SWE-Bench Verified": 80, "Terminal-Bench 2.1": 78 } }),
    entry({ key: "free", name: "Free", input: 0, cacheRead: 0, output: 0, benchmarks: { "SWE-Bench Verified": 70, "Terminal-Bench 2.1": 68 } }),
  ]
  const rows = buildRows(catalog, scales(catalog))
  const ordered = rank(rows, "value", "overall").map((row) => row.entry.key)
  assert.deepEqual(ordered, ["free", "cheap", "pricey"])
})

test("focus ranks on one benchmark and pushes models without it last", () => {
  const catalog = [
    entry({ key: "a", name: "A", benchmarks: { "SWE-Bench Verified": 90, "Terminal-Bench 2.1": 50 } }),
    entry({ key: "b", name: "B", benchmarks: { "SWE-Bench Verified": 60, "Terminal-Bench 2.1": 95 } }),
    entry({ key: "c", name: "C", benchmarks: { "SWE-Bench Verified": 30, "SWE-Bench Pro": 80 } }),
  ]
  const rows = buildRows(catalog, scales(catalog))
  const focused = rank(rows, "score", "Terminal-Bench 2.1")
  assert.equal(focused[0].entry.key, "b")
  // C has no Terminal-Bench run at all, so it sorts behind every ranked row
  assert.equal(focused.at(-1)?.entry.key, "c")
  const rowA = rows.find((row) => row.entry.key === "a")!
  assert.equal(focusScore(rowA, "SWE-Bench Verified"), 100)
})

test("peak factor scales every price", () => {
  const catalog = [entry({ key: "p", benchmarks: { "SWE-Bench Verified": 90, "Terminal-Bench 2.1": 90 }, peakFactor: 2 })]
  const [row] = buildRows(catalog, scales(catalog))
  assert.equal(row.tokenCost, 0.7 * 2 + 0.3 * 10)
})

test("cheap, cache, context and name sort every row, not just ranked ones", () => {
  const catalog = [
    entry({ key: "scored", name: "Scored", input: 10, cacheRead: 9, output: 10, context: 100_000, benchmarks: { "SWE-Bench Verified": 90, "Terminal-Bench 2.1": 90 } }),
    entry({ key: "unscored", name: "Unscored", input: 1, cacheRead: 0.1, output: 1, context: 400_000, benchmarks: { "SWE-Bench Verified": 90 } }),
  ]
  const rows = buildRows(catalog, scales(catalog))
  assert.equal(rows.find((row) => row.entry.key === "unscored")?.score, null)
  assert.equal(rank(rows, "cheap", "overall")[0].entry.key, "unscored")
  assert.equal(rank(rows, "context", "overall")[0].entry.key, "unscored")
  assert.equal(rank(rows, "cache", "overall")[0].entry.key, "unscored")
  assert.deepEqual(rank(rows, "name", "overall").map((row) => row.entry.key), ["scored", "unscored"])
  // A score-dependent view still keeps unranked rows out of the ranking.
  assert.equal(rank(rows, "score", "overall").at(-1)?.entry.key, "unscored")
})

test("utc_hours wraps midnight", () => {
  const night = { gte: "22:00", lt: "04:00" }
  assert.equal(matchesWhen({ utc_hours: night }, new Date("2026-01-01T22:00:00Z")), true)
  assert.equal(matchesWhen({ utc_hours: night }, new Date("2026-01-01T23:30:00Z")), true)
  assert.equal(matchesWhen({ utc_hours: night }, new Date("2026-01-02T03:59:00Z")), true)
  assert.equal(matchesWhen({ utc_hours: night }, new Date("2026-01-02T04:00:00Z")), false)
  assert.equal(matchesWhen({ utc_hours: night }, new Date("2026-01-01T21:59:00Z")), false)
  assert.equal(matchesWhen({ utc_hours: night }, new Date("2026-01-01T12:00:00Z")), false)
})

test("an unknown when-predicate fails closed", () => {
  assert.equal(matchesWhen({ utc_months: { in: [1] } }, new Date("2026-01-01T12:00:00Z")), false)
  assert.equal(matchesWhen({ any: [{ utc_days: { in: ["thu"] } }, { utc_months: {} }] }, new Date("2026-01-01T12:00:00Z")), true)
  assert.equal(matchesWhen({ all: [{ utc_days: { in: ["thu"] } }, { utc_months: {} }] }, new Date("2026-01-01T12:00:00Z")), false)
  assert.equal(matchesWhen({ utc_days: { in: ["thu"] } }, new Date("2026-01-01T12:00:00Z")), true)
})

test("peak factor follows the read clock, not the fetch clock", () => {
  const multipliers = [{ when: { utc_hours: { gte: "22:00", lt: "04:00" } }, factor: 2 }]
  const base = { key: "peak", benchmarks: { "SWE-Bench Verified": 90, "Terminal-Bench 2.1": 90 }, peakFactor: 1, multipliers }
  const catalog = [entry(base)]
  const table = scales(catalog)
  const offPeak = buildRows(catalog, table, new Date("2026-01-01T12:00:00Z"))[0]
  const peak = buildRows(catalog, table, new Date("2026-01-01T23:00:00Z"))[0]
  assert.equal(peakFactorAt(catalog[0], new Date("2026-01-01T12:00:00Z")), 1)
  assert.equal(peakFactorAt(catalog[0], new Date("2026-01-01T23:00:00Z")), 2)
  assert.equal(offPeak.tokenCost, 2.2)
  assert.equal(peak.tokenCost, 4.4)
})

test("money never renders NaN as free", () => {
  assert.equal(money(Number.NaN), "n/a")
  assert.equal(money(0), "free")
  assert.equal(money(Number.POSITIVE_INFINITY), "free")
  assert.equal(money(0.05), "$0.050")
})
