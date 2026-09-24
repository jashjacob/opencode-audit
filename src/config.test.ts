import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { loadConfig, requireModel, resolveSessionModel } from "./config.js"

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

describe("resolveSessionModel", () => {
  it("resolves the latest assistant model from the current SDK message shape", async () => {
    const sessionID = "sdk-model-fallback-test"
    const client = {
      session: {
        messages: async () => ({
          data: [
            { info: { role: "assistant", providerID: "old-provider", modelID: "old-model" }, parts: [] },
            { info: { role: "user", providerID: "user-provider", modelID: "user-model" }, parts: [] },
            { info: { role: "assistant", providerID: "deepseek", modelID: "deepseek-chat" }, parts: [] },
          ],
        }),
      },
    }

    const model = await resolveSessionModel(client, sessionID)
    deepStrictEqual(model, { providerID: "deepseek", modelID: "deepseek-chat" })
    // This is the call site behavior: successful SDK fallback avoids requiring
    // OPENCODE_AUDIT_MODEL explicitly.
    deepStrictEqual(requireModel(sessionID, model), { providerID: "deepseek", modelID: "deepseek-chat" })
  })

  it("continues to support legacy model response shapes", async () => {
    const client = {
      session: {
        messages: async () => ({
          data: [
            { info: { model: { providerID: "legacy-provider", modelID: "legacy-info-model" } } },
            { model: { providerID: "legacy-provider", modelID: "legacy-direct-model" } },
          ],
        }),
      },
    }

    deepStrictEqual(await resolveSessionModel(client, "legacy-model-fallback-test"), {
      providerID: "legacy-provider",
      modelID: "legacy-direct-model",
    })
  })
})
