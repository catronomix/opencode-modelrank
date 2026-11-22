import assert from "node:assert/strict"
import test from "node:test"

import type { ResolvedTheme } from "@opencode/theme/tui"

import { tones } from "../src/theme.ts"

// Colour values only have to survive the mapping, so the fixture uses plain
// strings tagged as the token type instead of building RGBA instances.
const token = (name: string) => name as unknown as ResolvedTheme["text"]["muted"]

test("a theme missing action and feedback groups renders with plain fallbacks", () => {
  const theme = { text: { muted: token("muted"), faint: token("faint") } } as unknown as ResolvedTheme

  const resolved = tones(theme)

  assert.equal(resolved.current, theme.text.muted)
  assert.equal(resolved.warn, theme.text.muted)
  assert.equal(resolved.plain, theme.text.muted)
  assert.equal(resolved.faint, theme.text.faint)
})

test("a theme with no text group at all resolves every tone to undefined", () => {
  const theme = {} as unknown as ResolvedTheme

  const resolved = tones(theme)

  assert.equal(resolved.plain, undefined)
  assert.equal(resolved.faint, undefined)
  assert.equal(resolved.current, undefined)
  assert.equal(resolved.warn, undefined)
  assert.equal(resolved.error, undefined)
})

test("a feedback group without an error token leaves only error unset", () => {
  const warning = token("warning")
  const theme = {
    text: { muted: token("muted"), faint: token("faint"), feedback: { warning: { base: warning } } },
  } as unknown as ResolvedTheme

  const resolved = tones(theme)

  assert.equal(resolved.warn, warning)
  assert.equal(resolved.error, undefined)
})

test("a full theme resolves the action and feedback tokens", () => {
  const primary = token("primary")
  const warning = token("warning")
  const theme = {
    text: {
      muted: token("muted"),
      faint: token("faint"),
      action: { primary: { base: primary } },
      feedback: { warning: { base: warning } },
    },
  } as unknown as ResolvedTheme

  const resolved = tones(theme)

  assert.equal(resolved.current, primary)
  assert.equal(resolved.warn, warning)
})
