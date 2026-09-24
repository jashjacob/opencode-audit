import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { loadConfig } from "./config.js"

describe("loadConfig", () => {
  it("caps concurrency and parses model configuration", () => {
    const previous = {
      concurrency: process.env.OPENCODE_AUDIT_CONCURRENCY,
      model: process.env.OPENCODE_AUDIT_MODEL,
    }
    try {
      process.env.OPENCODE_AUDIT_CONCURRENCY = "100"
      process.env.OPENCODE_AUDIT_MODEL = "provider/model/variant"
      const config = loadConfig()
      strictEqual(config.maxConcurrency, 8)
      deepStrictEqual(config.model, { providerID: "provider", modelID: "model/variant" })
    } finally {
      if (previous.concurrency === undefined) delete process.env.OPENCODE_AUDIT_CONCURRENCY
      else process.env.OPENCODE_AUDIT_CONCURRENCY = previous.concurrency
      if (previous.model === undefined) delete process.env.OPENCODE_AUDIT_MODEL
      else process.env.OPENCODE_AUDIT_MODEL = previous.model
    }
  })

  it("falls back to a safe concurrency for invalid values", () => {
    const previous = process.env.OPENCODE_AUDIT_CONCURRENCY
    try {
      process.env.OPENCODE_AUDIT_CONCURRENCY = "not-a-number"
      strictEqual(loadConfig().maxConcurrency, 5)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_AUDIT_CONCURRENCY
      else process.env.OPENCODE_AUDIT_CONCURRENCY = previous
    }
  })
})
