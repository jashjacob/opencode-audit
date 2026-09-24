import { mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { build } from "esbuild"

const output = process.env.OPENCODE_AUDIT_BUNDLE_OUT
  ? path.resolve(process.env.OPENCODE_AUDIT_BUNDLE_OUT)
  : path.join(
      process.env.OPENCODE_PLUGIN_DIR
        ? path.resolve(process.env.OPENCODE_PLUGIN_DIR)
        : path.join(os.homedir(), ".config", "opencode", "plugins"),
      "opencode-audit.js",
    )

await mkdir(path.dirname(output), { recursive: true })
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: output,
})
console.log(`Built ${output}`)
