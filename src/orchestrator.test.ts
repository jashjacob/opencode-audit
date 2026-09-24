import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { runPlaybook } from "./orchestrator.js"
import type { AuditConfig } from "./config.js"
import type { Playbook } from "./playbooks.js"

const config: AuditConfig = {
  debug: false,
  model: { providerID: "test-provider", modelID: "test-model" },
  maxConcurrency: 1,
  writeReport: false,
}

describe("runPlaybook SDK boundary", () => {
  it("creates child sessions and extracts text from the pinned SDK response shape", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-audit-orchestrator-"))
    const calls: { create?: unknown; prompt?: unknown; deleted?: string[] } = { deleted: [] }
    const client = {
      session: {
        create: async (args: unknown) => {
          calls.create = args
          return { data: { id: "probe-session" } }
        },
        prompt: async (args: unknown) => {
          calls.prompt = args
          return { data: { info: {}, parts: [{ type: "text", text: "- [low] src/a.ts:1 — unused value" }] } }
        },
        delete: async (args: { path: { id: string } }) => {
          calls.deleted?.push(args.path.id)
          return { data: true }
        },
      },
    } as unknown as OpencodeClient
    const playbook: Playbook = {
      id: "test",
      description: "SDK shape test",
      probes: [{ name: "one", agent: "explore", system: "read only", prompt: (target) => `audit ${target}` }],
    }

    const results = await runPlaybook(client, playbook, directory, config, directory, "parent-session", new AbortController().signal)

    strictEqual(results[0]?.text, "- [low] src/a.ts:1 — unused value")
    strictEqual(results[0]?.error, undefined)
    deepStrictEqual(calls.create, {
      body: { title: "audit:one", parentID: "parent-session" },
      query: { directory },
    })
    const prompt = calls.prompt as { path: { id: string }; body: { agent: string; model: unknown; parts: unknown[] } }
    strictEqual(prompt.path.id, "probe-session")
    strictEqual(prompt.body.agent, "explore")
    deepStrictEqual(prompt.body.model, config.model)
    deepStrictEqual(calls.deleted, ["probe-session"])
    rmSync(directory, { recursive: true, force: true })
  })

  it("marks an empty SDK reply as a failed probe instead of a successful empty result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-audit-orchestrator-"))
    const client = {
      session: {
        create: async () => ({ data: { id: "probe-session" } }),
        prompt: async () => ({ data: { info: {}, parts: [] } }),
        delete: async () => ({ data: true }),
      },
    } as unknown as OpencodeClient
    const playbook: Playbook = {
      id: "test",
      description: "empty reply test",
      probes: [{ name: "one", agent: "explore", system: "", prompt: () => "audit" }],
    }

    const results = await runPlaybook(client, playbook, directory, config, directory, "parent-session", new AbortController().signal)
    strictEqual(results[0]?.text, "")
    strictEqual(results[0]?.error, "probe returned no assistant text")
    rmSync(directory, { recursive: true, force: true })
  })
})
