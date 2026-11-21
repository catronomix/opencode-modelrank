import { solidPlugin } from "esbuild-plugin-solid"
import { defineConfig } from "tsup"

const external = [
  "@opencode/plugin",
  "@opencode/plugin/tui",
  "@opencode/plugin/tui/context",
  "@opentui/core",
  "@opentui/solid",
  "solid-js",
]

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node22",
    dts: { entry: { index: "src/index.ts" } },
    bundle: true,
    splitting: false,
    clean: true,
    outDir: "dist",
    external,
  },
  {
    entry: { tui: "src/tui.tsx" },
    format: ["esm"],
    target: "node22",
    dts: { entry: { tui: "src/tui.tsx" } },
    bundle: true,
    splitting: false,
    clean: false,
    outDir: "dist",
    external,
    esbuildPlugins: [
      solidPlugin({ solid: { generate: "universal", moduleName: "@opentui/solid" } }),
    ],
  },
])
