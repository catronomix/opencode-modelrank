import { Plugin } from "@opencode/plugin"

/**
 * Server-side half. The comparison lives entirely in the TUI; this entry
 * exists so the package can be loaded like any other plugin while `./tui`
 * supplies the sidebar slot and the /ocmodels command.
 */
export default Plugin.define({
  id: "opencode-ocmodels",
  setup() {},
})
