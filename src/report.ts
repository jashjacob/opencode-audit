import type { Playbook } from "./playbooks.js"
import type { ProbeResult } from "./orchestrator.js"
import { redactSensitiveText } from "./state.js"
const FINDING_RE = /^\s*-\s+\[(high|med|low)\]\s+(\S+)\s+—\s+(.+)\s*$/i
const LOCATION_RE = /^(?:(?:[A-Za-z]:[\\/])?[A-Za-z0-9._~+@-][A-Za-z0-9._~+@/\\-]*(?::\d{1,6})?|route:[A-Za-z0-9._~/-]+|url:[A-Za-z0-9._~:/?#&=%+-]+)$/i
const EVIDENCE_RE = /^\s*-\s+evidence:\s*(.+)$/i
const NOTE_RE = /^\s*(?:-\s*)?note:\s*(.+)$/i
const MAX_FINDING_LENGTH = 1_000
const MAX_EVIDENCE_LENGTH = 500
const MAX_NOTE_LENGTH = 500
const MAX_FINDINGS_PER_PROBE = 20

function validLocation(location: string): boolean {
  return LOCATION_RE.test(location) && !location.split(/[\\/]/).includes("..")
}

type ParsedProbeOutput = { body: string; findings: number; malformed: number; severityCounts: Record<string, number> }

export function parseProbeOutput(text: string): ParsedProbeOutput {
  const rendered: string[] = []
  let currentFinding = false
  let sawCleanMarker = false
  let noteCount = 0
  let findings = 0
  let malformed = 0
  const severityCounts: Record<string, number> = { high: 0, med: 0, low: 0 }
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    if (line === "No findings.") {
      if (findings === 0 && !sawCleanMarker) {
        sawCleanMarker = true
        rendered.push("> No findings.")
      } else {
        malformed += 1
      }
      currentFinding = false
      continue
    }
    const note = line.match(NOTE_RE)
    if (note?.[1]) {
      if (noteCount === 0 && note[1].length <= MAX_NOTE_LENGTH) {
        rendered.push(`> Note: ${redactSensitiveText(note[1])}`)
        noteCount += 1
      } else {
        malformed += 1
      }
      currentFinding = false
      continue
    }
    const evidence = raw.match(EVIDENCE_RE)
    if (evidence?.[1] && currentFinding && evidence[1].length <= MAX_EVIDENCE_LENGTH) {
      rendered.push(`    - evidence: ${redactSensitiveText(evidence[1])}`)
      continue
    }
    const finding = raw.match(FINDING_RE)
    if (
      finding?.[1] && finding[2] && finding[3] && validLocation(finding[2]) &&
      finding[3].trim().length > 0 && finding[3].length <= MAX_FINDING_LENGTH && !sawCleanMarker &&
      findings < MAX_FINDINGS_PER_PROBE
    ) {
      const severity = finding[1].toLowerCase() as "high" | "med" | "low"
      const location = redactSensitiveText(finding[2])
      const issue = redactSensitiveText(finding[3].trim())
      rendered.push(`  - [${severity}] ${location} — ${issue}`)
      findings += 1
      severityCounts[severity] = (severityCounts[severity] ?? 0) + 1
      currentFinding = true
      continue
    }
    currentFinding = false
    malformed += 1
  }
  if (malformed) {
    rendered.push(`> ⚠ ignored ${malformed} malformed or excess output line${malformed === 1 ? "" : "s"}; only contract-valid findings are actionable.`)
  }
  if (!findings && !sawCleanMarker && !malformed) malformed += 1
  if (!findings && !rendered.length && malformed) rendered.push("> No valid output was returned.")
  return { body: rendered.join("\n"), findings, malformed, severityCounts }
}

export function isProbeOutputMalformed(text: string): boolean {
  return parseProbeOutput(text).malformed > 0
}

export function renderReport(playbook: Playbook, results: ProbeResult[], target: string): string {
  const parsed = results.map((result) => ({ result, output: parseProbeOutput(result.text) }))
  const sections = parsed.map(({ result: { probe, error }, output }) => {
    if (error) {
      const safeError = redactSensitiveText(error)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
        .split(/\r?\n/)
      const quotedError = safeError.map((line, index) => index === 0 ? `> probe failed: ${line}` : `> ${line}`).join("\n")
      return `## ${probe.name}\n\n${quotedError}\n`
    }
    const status = output.malformed
      ? `> ⚠ malformed output: ${output.malformed} line${output.malformed === 1 ? "" : "s"} did not match the probe contract.\n\n`
      : ""
    return `## ${probe.name} (${probe.agent})\n\n${status}${output.body}\n`
  })

  const failed = results.filter((r) => r.error)
  const malformed = parsed.filter(({ result, output }) => !result.error && output.malformed > 0).length
  const summaryParts = [`${results.length - failed.length - malformed} of ${results.length} probes completed successfully`]
  if (failed.length) summaryParts.push(`${failed.length} failed`)
  if (malformed) summaryParts.push(`${malformed} returned malformed output`)
  const summary = `> ${summaryParts.join("; ")}.`

  const severityCounts: Record<string, number> = { high: 0, med: 0, low: 0 }
  for (const { result, output } of parsed) {
    if (result.error) continue
    for (const severity of Object.keys(severityCounts)) {
      severityCounts[severity] = (severityCounts[severity] ?? 0) + (output.severityCounts[severity] ?? 0)
    }
  }
  const severitySummary = `> severity counts: high ${severityCounts.high ?? 0}, med ${severityCounts.med ?? 0}, low ${severityCounts.low ?? 0}`

  return [
    `# ${playbook.id} audit`,
    `- target: \`${redactSensitiveText(target).replace(/[\r\n`]/g, "").slice(0, 2_000)}\``,
    `- time: ${new Date().toISOString()}`,
    "",
    severitySummary,
    summary,
    "",
    ...sections,
  ].join("\n")
}
