import type { Playbook } from "./playbooks.js"
import type { ProbeResult } from "./orchestrator.js"
import { parseFindingLine } from "./state.js"

const BULLET_PREFIX_RE = /^(?:-\s|\d+[.)]\s)/

function indentOf(raw: string): number {
  const m = raw.match(/^[ \t]*/)
  return m ? m[0].length : 0
}

function bulletContent(trimmed: string): string {
  return BULLET_PREFIX_RE.test(trimmed) ? trimmed.replace(BULLET_PREFIX_RE, "") : trimmed
}

function renderProbeBody(text: string): string {
  let findingIndent: number | null = null
  const rendered: string[] = []
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const indent = indentOf(raw)
    const content = bulletContent(trimmed)
    if (/^note:/i.test(content)) {
      rendered.push(`> ${content}`)
      continue
    }
    if (BULLET_PREFIX_RE.test(trimmed)) {
      if ((findingIndent !== null && indent > findingIndent) || /^evidence:/i.test(content)) {
        rendered.push(`    ${trimmed}`)
        continue
      }
      findingIndent = indent
      rendered.push(`  ${trimmed}`)
      continue
    }
    if (findingIndent !== null && indent > findingIndent) {
      rendered.push(`    - ${trimmed}`)
      continue
    }
    rendered.push(`  - ${trimmed}`)
  }
  return rendered.join("\n")
}

export function renderReport(playbook: Playbook, results: ProbeResult[], target: string): string {
  const sections = results.map(({ probe, text, error }) => {
    if (error) {
      return `## ${probe.name}\n\n> probe failed: ${error}\n`
    }
    const lines = renderProbeBody(text)
    return `## ${probe.name} (${probe.agent})\n\n${lines}\n`
  })

  const failed = results.filter((r) => r.error)
  const summary = failed.length
    ? `> ⚠ ${failed.length} of ${results.length} probes failed.`
    : `> All ${results.length} probes completed.`

  const severityCounts: Record<string, number> = { high: 0, med: 0, low: 0 }
  for (const result of results) {
    for (const raw of result.text.split("\n")) {
      const content = bulletContent(raw.trim())
      if (/^(?:evidence|note):/i.test(content)) continue
      const parsed = parseFindingLine(raw)
      if (!parsed || !parsed.tagged) continue
      severityCounts[parsed.severity] = (severityCounts[parsed.severity] ?? 0) + 1
    }
  }
  const severitySummary = `> severity counts: high ${severityCounts.high ?? 0}, med ${severityCounts.med ?? 0}, low ${severityCounts.low ?? 0}`

  return [
    `# ${playbook.id} audit`,
    `- target: \`${target}\``,
    `- time: ${new Date().toISOString()}`,
    "",
    severitySummary,
    summary,
    "",
    ...sections,
  ].join("\n")
}
