import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import type { BoxRenderable } from "@opentui/core"
import { createMemo, createSignal, onCleanup } from "solid-js"

import { fetchSnapshot, readCache, writeCache, MAX_AGE_MS, type Snapshot } from "./data.ts"
import {
  buildRows,
  FOCUSES,
  FOCUS_LABEL,
  focusScore,
  isOnPlan,
  money,
  plansLabel,
  rank,
  scales,
  SORT_LABEL,
  SORTS,
  truncate,
  type Entry,
  type Focus,
  type Sort,
} from "./logic.ts"

type Settings = { sort: Sort; focus: Focus; rows: number; excluded: string[] }
type Store = { status: "idle" | "loading" | "ready" | "error"; at: number; entries: Entry[]; note: string }

const ROW_CHOICES = [4, 6, 8, 12, 16, 24]

function age(at: number): string {
  if (!at) return "never"
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return `${hours}h ago`
}

export default Plugin.define({
  id: "ocmodels.tui",
  async setup(context) {
    // Reasonably loose typing: the storage and dialog shapes are stable but
    // the published generics differ between minor releases.
    const storage = context.storage as unknown as {
      store<T>(name: string, options: { initial: T }): [T, (fn: (draft: T) => void) => Promise<void>]
      memory<T>(name: string, options: { initial: T }): [T, (fn: (draft: T) => void) => void]
    }

    const [settings, updateSettings] = storage.store<Settings>("ocmodels", {
      initial: { sort: "value", focus: "overall", rows: 8, excluded: [] },
    })
    const [store, updateStore] = storage.memory<Store>("ocmodels.data", {
      initial: { status: "idle", at: 0, entries: [], note: "" },
    })

    const apply = (snapshot: Snapshot, cached: boolean) => {
      updateStore((draft) => {
        draft.entries = snapshot.entries
        draft.at = snapshot.at
        draft.status = "ready"
        draft.note = cached ? "cached" : ""
      })
    }

    const refresh = async (options: { force?: boolean; quiet?: boolean } = {}) => {
      updateStore((draft) => {
        draft.status = "loading"
        draft.note = "fetching Zen/Go catalogs + benchmarks…"
      })
      try {
        const snapshot = await fetchSnapshot()
        await writeCache(snapshot)
        apply(snapshot, false)
        if (!options.quiet) {
          context.ui.toast.show({
            title: "OC Models",
            message: `${snapshot.entries.length} models ranked${snapshot.missing.length ? `, ${snapshot.missing.length} without data` : ""}.`,
            variant: "success",
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        updateStore((draft) => {
          draft.status = "error"
          draft.note = message
        })
        if (!options.quiet) context.ui.toast.show({ title: "OC Models", message, variant: "error" })
      }
    }

    void (async () => {
      const cached = await readCache()
      if (!cached) return refresh({ quiet: true })
      apply(cached, true)
      if (Date.now() - cached.at > MAX_AGE_MS) void refresh({ quiet: true })
    })()

    // ---- menus -----------------------------------------------------------

    const included = () => {
      const excluded = new Set(settings.excluded)
      return store.entries.filter((entry) => !excluded.has(entry.key))
    }

    const sortLabel = () => SORT_LABEL[settings.sort]

    const pickSort = async () => {
      const choice = await context.ui.dialog.select({
        title: "Sort models by",
        current: settings.sort,
        options: SORTS.map((sort) => ({
          title: SORT_LABEL[sort],
          value: sort,
          description:
            sort === "value"
              ? "benchmark score divided by the cost of a representative session"
              : sort === "score"
                ? "benchmark score alone (needs two tracked benchmarks)"
                : sort === "cheap"
                  ? "blended $/1M tokens, cheapest first"
                  : sort === "cache"
                    ? "cache-read price ÷ input price, lowest first"
                    : sort === "context"
                      ? "largest context window first"
                      : "alphabetical",
        })),
      })
      if (!choice) return
      await updateSettings((draft) => {
        draft.sort = choice as Sort
      })
      await context.ui.toast.show({ title: "OC Models", message: `Sorted by ${sortLabel()}`, variant: "success" })
    }

    const pickFocus = async () => {
      const choice = await context.ui.dialog.select({
        title: "Rank on which benchmark?",
        current: settings.focus,
        options: FOCUSES.map((focus) => ({
          title: FOCUS_LABEL[focus],
          value: focus,
          description: focus === "overall" ? "median of every tracked benchmark the model carries" : "one benchmark, scaled 0-100 across the catalog",
        })),
      })
      if (!choice) return
      await updateSettings((draft) => {
        draft.focus = choice as Focus
      })
      await context.ui.toast.show({ title: "OC Models", message: `Focus: ${FOCUS_LABEL[choice as Focus]}`, variant: "success" })
    }

    const pickRows = async () => {
      const choice = await context.ui.dialog.select({
        title: "Sidebar rows",
        current: String(settings.rows),
        options: ROW_CHOICES.map((count) => ({ title: `${count} models`, value: String(count) })),
      })
      if (!choice) return
      await updateSettings((draft) => {
        draft.rows = Number(choice) || 8
      })
    }

    const pickModels = async () => {
      if (!store.entries.length) {
        context.ui.toast.show({ title: "OC Models", message: "No models loaded yet. Use “Refresh data”.", variant: "warning" })
        return
      }
      for (;;) {
        const excluded = new Set(settings.excluded)
        const total = store.entries.length
        const count = total - excluded.size
        const choice = await context.ui.dialog.select({
          title: `Models in the comparison (${count}/${total})`,
          options: [
            { title: "[x] Include all", value: "__all", category: "Actions" },
            { title: "[ ] Exclude all", value: "__none", category: "Actions" },
            { title: "Only free models", value: "__free", category: "Actions" },
            { title: "Only Go plan", value: "__go", category: "Actions" },
            { title: "Only Zen plan", value: "__zen", category: "Actions" },
            ...store.entries.map((entry) => ({
              title: `${excluded.has(entry.key) ? "[ ]" : "[x]"} ${entry.name}`,
              value: entry.key,
              description: `${plansLabel(entry)} · ${entry.free ? "free" : `${money(entry.input)} in / ${money(entry.output)} out`} · ${Math.round(entry.context / 1000)}k ctx`,
              category: entry.free ? "Free" : plansLabel(entry),
            })),
          ],
        })
        if (!choice) return
        if (choice === "__all") {
          await updateSettings((draft) => {
            draft.excluded = []
          })
          continue
        }
        if (choice === "__none") {
          await updateSettings((draft) => {
            draft.excluded = store.entries.map((entry) => entry.key)
          })
          continue
        }
        if (choice === "__free") {
          await updateSettings((draft) => {
            draft.excluded = store.entries.filter((entry) => !entry.free).map((entry) => entry.key)
          })
          continue
        }
        if (choice === "__go" || choice === "__zen") {
          const plan = choice === "__go" ? "opencode-go" : "opencode"
          await updateSettings((draft) => {
            draft.excluded = store.entries.filter((entry) => !isOnPlan(entry, plan)).map((entry) => entry.key)
          })
          continue
        }
        await updateSettings((draft) => {
          const set = new Set(draft.excluded)
          if (set.has(choice)) set.delete(choice)
          else set.add(choice)
          draft.excluded = [...set]
        })
      }
    }

    const menu = async () => {
      for (;;) {
        const count = included().length
        const choice = await context.ui.dialog.select({
          title: "OC Models — benchmark + price comparison",
          options: [
            {
              title: `Sort — ${sortLabel()}`,
              value: "sort",
              description: "score per $, raw score, $/1M, cache ratio, context, name",
            },
            { title: `Benchmark focus — ${FOCUS_LABEL[settings.focus]}`, value: "focus" },
            { title: `Models included — ${count}/${store.entries.length}`, value: "models", description: "pick which models appear in the comparison" },
            { title: `Sidebar rows — ${settings.rows}`, value: "rows" },
            { title: `Refresh data — ${age(store.at)}`, value: "refresh", description: "refetch Zen/Go catalogs and benchmark records" },
            { title: "Done", value: "done" },
          ],
        })
        if (!choice || choice === "done") return
        if (choice === "sort") await pickSort()
        else if (choice === "focus") await pickFocus()
        else if (choice === "models") await pickModels()
        else if (choice === "rows") await pickRows()
        else if (choice === "refresh") await refresh()
      }
    }

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: () => <Sidebar context={context} settings={settings} store={store} open={menu} />,
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "ocmodels.menu",
          title: "Model comparison (score vs price)",
          description: "Choose models and sorting for the Zen/Go score-per-dollar sidebar",
          group: "Models",
          palette: true,
          slash: { name: "ocmodels", aliases: ["ocm"] },
          suggested: true,
          run: () => menu(),
        },
        {
          id: "ocmodels.refresh",
          title: "Refresh model comparison data",
          group: "Models",
          palette: true,
          run: () => refresh(),
        },
      ],
    }))

    return () => unregister()
  },
})

type SidebarProps = {
  context: Context
  settings: Settings
  store: Store
  open: () => Promise<void>
}

const DAY_MS = 86_400_000

/** `strong` is the only stronger verified shade of `markdown.heading`; there is no heading ramp in the host schema. */
function scoreShade(score: number | null): "heading" | "strong" | undefined {
  if (score === null) return undefined
  if (score >= 95) return "strong"
  if (score >= 80) return "heading"
  return undefined
}

function isStale(at: number): boolean {
  return at > 0 && Date.now() - at >= DAY_MS
}

export function Sidebar(props: SidebarProps) {
  const table = createMemo(() => scales(props.store.entries))
  // Hourly price multipliers must follow the clock, so the rows memo reads a
  // coarse tick instead of freezing the factor at mount time.
  const [clock, setClock] = createSignal(new Date())
  const timer = setInterval(() => setClock(new Date()), 60_000)
  onCleanup(() => clearInterval(timer))
  const rows = createMemo(() => {
    const excluded = new Set(props.settings.excluded)
    const kept = props.store.entries.filter((entry) => !excluded.has(entry.key))
    return rank(buildRows(kept, table(), clock()), props.settings.sort, props.settings.focus)
  })
  const current = () => props.context.ui.model.current?.()
  const isCurrent = (entry: Entry) => {
    const model = current()
    if (!model) return false
    if (model.modelID !== entry.id) return false
    return isOnPlan(entry, model.providerID as typeof entry.provider)
  }
  const shown = createMemo(() => rows().slice(0, Math.max(1, props.settings.rows)))
  const tones = createMemo(() => {
    const theme = props.context.theme
    const markdown = theme.markdown ?? {}
    return {
      current: theme.text.action.primary.base,
      plain: theme.text.muted,
      faint: theme.text.faint,
      warn: theme.text.feedback.warning.base,
      error: theme.text.feedback?.error?.base,
      link: markdown.linkText,
      heading: markdown.heading,
      strong: markdown.strong,
      cheap: markdown.emphasis,
    }
  })

  // The sidebar slot does not tell us its width, so measure our own box and
  // size the name column to whatever is actually left. A fixed width overflows
  // once the host sidebar is narrower than the row.
  const ROW_OVERHEAD = 15 // marker+rank+space │ score space cost
  const [boxWidth, setBoxWidth] = createSignal(0)
  const nameWidth = createMemo(() => {
    const width = boxWidth()
    if (width <= 0) return 18
    return Math.max(6, width - ROW_OVERHEAD)
  })
  const fitWidth = () => Math.max(12, boxWidth() || 34)
  const fit = (text: string) => truncate(text, fitWidth())

  const line = (row: ReturnType<typeof buildRows>[number], index: number, score: number | null) => {
    const width = nameWidth()
    const name = truncate(row.entry.name, width).padEnd(width)
    const rankText = String(index + 1).padStart(2)
    const scoreText = score === null ? " --" : String(Math.round(score)).padStart(3)
    const cost = (row.entry.free ? "free" : money(row.tokenCost)).padStart(5)
    return { head: `${rankText} ${name} │`, score: `${scoreText} `, cost }
  }

  let root: BoxRenderable | undefined

  const footHead = () => `${shown().length}/${rows().length} · /ocmodels`
  const footSeparator = " · "
  const footRoom = () => fitWidth() - Math.min(footHead().length, fitWidth()) - footSeparator.length

  return (
    <box
      flexDirection="column"
      ref={(el) => {
        root = el
        setBoxWidth(el.width)
      }}
      onSizeChange={() => {
        if (root) setBoxWidth(root.width)
      }}
    >
      <box flexDirection="row">
        <text fg={tones().current}>MODELS</text>
        <text fg={tones().plain}>{` ▸ ${SORT_LABEL[props.settings.sort]}`}</text>
      </box>
      <text fg={tones().faint}>{fit(`focus: ${FOCUS_LABEL[props.settings.focus]}`)}</text>
      {props.store.status === "loading" ? <text fg={tones().warn}>loading…</text> : null}
      {props.store.status === "error" ? <text fg={tones().warn}>{fit(props.store.note)}</text> : null}
      {props.store.status === "ready" && shown().length === 0 ? <text fg={tones().plain}>no models selected</text> : null}
      <text> </text>
      {shown().map((row, index) => {
        const score = focusScore(row, props.settings.focus)
        const parts = line(row, index, score)
        const currentRow = isCurrent(row.entry)
        const shade = scoreShade(score)
        const scoreFg = (shade === "strong" ? tones().strong ?? tones().heading : shade === "heading" ? tones().heading : undefined) ?? tones().plain
        const costFg = row.tokenCost < 1 ? tones().cheap ?? tones().plain : tones().plain
        return (
          <box flexDirection="row">
            <text fg={currentRow ? tones().current : tones().plain}>{currentRow ? "▸" : " "}</text>
            <text fg={tones().plain}>{parts.head}</text>
            <text fg={scoreFg}>{parts.score}</text>
            <text fg={costFg}>{parts.cost}</text>
          </box>
        )
      })}
      <text> </text>
      <box flexDirection="row">
        <text fg={tones().link}>{fit(footHead())}</text>
        {footRoom() > 0 ? (
          <text fg={isStale(props.store.at) ? tones().error : tones().faint}>{`${footSeparator}${truncate(age(props.store.at), footRoom())}`}</text>
        ) : null}
      </box>
      {props.store.status === "ready" && rows().some((row) => row.score === null) ? (
        <text fg={tones().faint}>{fit(`${rows().filter((row) => row.score === null).length} unranked (1 benchmark or none)`)}</text>
      ) : null}
    </box>
  )
}
