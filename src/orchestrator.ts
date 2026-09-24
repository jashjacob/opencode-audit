import type { OpencodeClient } from "@opencode-ai/sdk"
import type { AuditConfig } from "./config.js"
import type { Playbook, Probe } from "./playbooks.js"
import { extractSessionText, promptWithAbort, READ_ONLY_TOOLS } from "./session.js"
import { redactSensitiveText } from "./state.js"

export type ProbeResult = {
  probe: Probe
  text: string
  error?: string
}

async function runProbe(
  client: OpencodeClient,
  probe: Probe,
  target: string,
  config: AuditConfig,
  directory: string,
  parentSessionID: string,
  signal: AbortSignal,
): Promise<ProbeResult> {
  let sessionID: string | undefined
  try {
    if (signal.aborted) throw new Error("audit aborted")
    const created = await client.session.create({
      body: { title: `audit:${probe.name}`, parentID: parentSessionID },
      query: { directory },
    })
    sessionID = created?.data?.id
    if (!sessionID) throw new Error("session.create returned no id")

    const reply = await promptWithAbort(client, sessionID, directory, signal, () =>
      client.session.prompt({
        path: { id: sessionID as string },
        query: { directory },
        body: {
          agent: probe.agent,
          // Deny by default so project-installed MCP/custom tools cannot expand the probe's powers.
          tools: READ_ONLY_TOOLS,
          system: probe.system,
          parts: [{ type: "text", text: probe.prompt(target) }],
          ...(config.model ? { model: config.model } : {}),
        },
      }),
    )
    const text = extractSessionText(reply)
    if (!text) throw new Error("probe returned no assistant text")
    return { probe, text }
  } catch (err) {
    return {
      probe,
      text: "",
      error: redactSensitiveText(err instanceof Error ? err.message : String(err)),
    }
  } finally {
    if (sessionID) {
      await client.session.delete({ path: { id: sessionID }, query: { directory } }).catch(() => {})
    }
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<ProbeResult>,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index] as T, index)
    }
  })
  await Promise.all(workers)
  return results
}

export async function runPlaybook(
  client: OpencodeClient,
  playbook: Playbook,
  target: string,
  config: AuditConfig,
  directory: string,
  parentSessionID: string,
  signal: AbortSignal,
  onProgress?: (completed: number, total: number, probe: Probe, phase: "running" | "complete") => void,
): Promise<ProbeResult[]> {
  let completed = 0
  return mapWithConcurrency(playbook.probes, config.maxConcurrency, async (probe) => {
    onProgress?.(completed, playbook.probes.length, probe, "running")
    const result = await runProbe(client, probe, target, config, directory, parentSessionID, signal)
    completed += 1
    onProgress?.(completed, playbook.probes.length, probe, "complete")
    return result
  },
  )
}
