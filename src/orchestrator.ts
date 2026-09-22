import type { OpencodeClient } from "@opencode-ai/sdk"
import type { AuditConfig } from "./config.js"
import type { Playbook, Probe } from "./playbooks.js"

export type ProbeResult = {
  probe: Probe
  text: string
  error?: string
}

type SessionPart = {
  type?: string
  text?: string
}

function extractText(reply: unknown): string {
  const r = reply as {
    parts?: SessionPart[]
    content?: string
    data?: { parts?: SessionPart[]; content?: string }
  }
  const parts = r?.parts || r?.data?.parts || []
  const texts = parts
    .filter((p) => p?.type === "text" && typeof p?.text === "string")
    .map((p) => (p as { text: string }).text)
    .join("\n")
  if (texts.trim()) return texts.trim()
  const content = r?.content || r?.data?.content
  if (typeof content === "string" && content.trim()) return content.trim()
  return ""
}

async function runProbe(
  client: OpencodeClient,
  probe: Probe,
  target: string,
  config: AuditConfig,
  directory: string,
  parentSessionID: string,
): Promise<ProbeResult> {
  try {
    const created = await client.session.create({
      body: { title: `audit:${probe.name}`, parentID: parentSessionID },
      query: { directory },
    })
    const sessionID = created?.data?.id
    if (!sessionID) throw new Error("session.create returned no id")

    const reply = await client.session.prompt({
      path: { id: sessionID },
      query: { directory },
      body: {
        agent: probe.agent,
        system: probe.system,
        parts: [{ type: "text", text: probe.prompt(target) }],
        ...(config.model ? { model: config.model } : {}),
      },
    })
    const text = extractText(reply)
    if (!text) throw new Error("probe returned no assistant text")
    return { probe, text }
  } catch (err) {
    return {
      probe,
      text: "",
      error: err instanceof Error ? err.message : String(err),
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
): Promise<ProbeResult[]> {
  return mapWithConcurrency(playbook.probes, config.maxConcurrency, (probe) =>
    runProbe(client, probe, target, config, directory, parentSessionID),
  )
}