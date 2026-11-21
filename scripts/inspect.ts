/**
 * Manual check against the live endpoints: `node scripts/inspect.ts`
 * Prints coverage plus the top of each view, without touching the cache.
 */
import { fetchSnapshot } from "../src/data.ts"
import { buildRows, focusScore, money, rank, scales, type Focus, type Sort } from "../src/logic.ts"

const snapshot = await fetchSnapshot()
const rows = buildRows(snapshot.entries, scales(snapshot.entries))
const scored = rows.filter((row) => row.score !== null)
console.log(`models: ${rows.length} · ranked: ${scored.length} · missing records: ${snapshot.missing.length}`)
if (snapshot.missing.length) console.log(`missing: ${snapshot.missing.slice(0, 8).join(", ")}${snapshot.missing.length > 8 ? "…" : ""}`)

const show = (sort: Sort, focus: Focus, count = 10) => {
  console.log(`\n== ${sort} / ${focus}`)
  for (const row of rank(rows, sort, focus).slice(0, count)) {
    const score = focusScore(row, focus)
    console.log(
      [
        row.entry.key.padEnd(38),
        (score === null ? "--" : Math.round(score).toString()).padStart(3),
        money(row.tokenCost).padStart(7),
        money(row.sessionCost).padStart(8),
        `${Math.round(row.entry.context / 1000)}k`.padStart(5),
        row.entry.free ? "free" : "",
      ].join(" "),
    )
  }
}

show("value", "overall")
show("score", "overall")
show("score", "Terminal-Bench 2.1")
show("score", "SWE-Bench Verified")
show("cheap", "overall", 5)
