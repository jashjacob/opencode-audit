import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import pluginFactory from "./index.js"

describe("default plugin export", () => {
  it("registers the audit and fix tools and config commands", async () => {
    const plugin = await pluginFactory({ client: {} } as never)
    deepStrictEqual(Object.keys(plugin.tool).sort(), ["audit_fleet", "fix_fleet"])

    const config: { command?: Record<string, unknown> } = {}
    await plugin.config?.(config as never)
    strictEqual(config.command?.audit !== undefined, true)
    strictEqual(config.command?.fix !== undefined, true)
  })
})
