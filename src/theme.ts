import type { ResolvedTheme } from "@opencode/theme/tui"
import type { RGBA } from "@opentui/core"

export type Tones = {
  current: RGBA | undefined
  plain: RGBA | undefined
  faint: RGBA | undefined
  warn: RGBA | undefined
  error: RGBA | undefined
  link: RGBA | undefined
  heading: RGBA | undefined
  strong: RGBA | undefined
  cheap: RGBA | undefined
}

/**
 * Every token the sidebar reads, resolved once. The host's `ResolvedTheme`
 * declares the full token set, but a user theme can resolve without a group
 * (and the next host release can drop one), so the optional groups — `text`,
 * `text.action`, `text.feedback`, `markdown` — are read guarded and fall back
 * to the plain text colour instead of throwing inside the render loop.
 */
export function tones(theme: ResolvedTheme): Tones {
  const markdown = theme.markdown ?? {}
  const plain = theme.text?.muted
  return {
    current: theme.text?.action?.primary?.base ?? plain,
    plain,
    faint: theme.text?.faint,
    warn: theme.text?.feedback?.warning?.base ?? plain,
    error: theme.text?.feedback?.error?.base,
    link: markdown.linkText,
    heading: markdown.heading,
    strong: markdown.strong,
    cheap: markdown.emphasis,
  }
}
