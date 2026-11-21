import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { after } from "node:test"

import { cacheFile, readCache, SNAPSHOT_SCHEMA, writeCache, type Snapshot } from "../src/data.ts"
import type { Entry } from "../src/logic.ts"

const dir = await mkdtemp(join(tmpdir(), "ocmodels-cache-"))
process.env.OPENCODE_OCMODELS_DATA = dir
after(() => rm(dir, { recursive: true, force: true }))

const entry = (over: Partial<Entry> = {}): Entry => ({
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

const snapshot = (entries: Entry[] = [entry()]): Snapshot => ({ schema: SNAPSHOT_SCHEMA, at: Date.now(), entries, missing: [] })

test("a written snapshot round-trips", async () => {
  await writeCache(snapshot())
  const cached = await readCache()
  assert.equal(cached?.schema, SNAPSHOT_SCHEMA)
  assert.equal(cached?.entries.length, 1)
})

test("a snapshot without the current schema is a miss", async () => {
  await writeFile(cacheFile(), JSON.stringify({ at: Date.now(), entries: [entry()], missing: [] }))
  assert.equal(await readCache(), undefined)
  await writeFile(cacheFile(), JSON.stringify({ ...snapshot(), schema: SNAPSHOT_SCHEMA - 1 }))
  assert.equal(await readCache(), undefined)
})

test("a snapshot with a malformed row is a miss", async () => {
  const { peakFactor: _dropped, ...noPeak } = entry()
  await writeFile(cacheFile(), JSON.stringify({ ...snapshot(), entries: [noPeak] }))
  assert.equal(await readCache(), undefined)
  await writeFile(cacheFile(), JSON.stringify({ ...snapshot(), entries: [{ ...entry(), input: Number.NaN }] }))
  assert.equal(await readCache(), undefined)
  await writeFile(cacheFile(), JSON.stringify({ ...snapshot(), entries: [{ ...entry(), benchmarks: undefined }] }))
  assert.equal(await readCache(), undefined)
  await writeFile(
    cacheFile(),
    JSON.stringify({ ...snapshot(), entries: [{ ...entry(), multipliers: [{ when: {}, factor: Number.POSITIVE_INFINITY }] }] }),
  )
  assert.equal(await readCache(), undefined)
})

test("an unreadable cache file is a miss", async () => {
  await writeFile(cacheFile(), "{not json")
  assert.equal(await readCache(), undefined)
})
