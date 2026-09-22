import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

export type AuditSnapshot = {
  playbook: string
  target: string
  time: string
  findings: string[]
}

export function shouldSaveSnapshot(results: readonly { error?: string }[]): boolean {
  return results.length > 0 && results.every((result) => !result.error)
}

export function snapshotDir(projectPath: string): string {
  const slug = `${basename(projectPath).replace(/[^a-zA-Z0-9._-]/g, "_")}-${createHash("sha256").update(projectPath).digest("hex").slice(0, 8)}`
  return join(homedir(), ".local", "share", "opencode", "audit", slug)
}

function snapshotFile(playbook: string, projectPath: string): string {
  const safe = playbook.replace(/[^a-zA-Z0-9._-]/g, "_")
  return join(snapshotDir(projectPath), `${safe}.json`)
}

export function loadSnapshot(playbook: string, projectPath: string): AuditSnapshot | null {
  try {
    const file = snapshotFile(playbook, projectPath)
    if (!existsSync(file)) return null
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Partial<AuditSnapshot>
    if (
      typeof r.playbook !== "string" ||
      typeof r.target !== "string" ||
      typeof r.time !== "string" ||
      !Array.isArray(r.findings) ||
      !r.findings.every((f) => typeof f === "string")
    ) {
      return null
    }
    return { playbook: r.playbook, target: r.target, time: r.time, findings: r.findings }
  } catch {
    return null
  }
}

export function saveSnapshot(snapshot: AuditSnapshot): void {
  try {
    const file = snapshotFile(snapshot.playbook, snapshot.target)
    mkdirSync(snapshotDir(snapshot.target), { recursive: true })
    writeFileSync(file, JSON.stringify(snapshot, null, 2), "utf8")
  } catch {}
}

export type Severity = "high" | "med" | "low"

export type ParsedFinding = {
  severity: Severity
  location: string
  key: string
  issue: string
  structured: boolean
  tagged: boolean
}

const SEVERITY_TAGS: Record<string, Severity> = {
  high: "high",
  med: "med",
  medium: "med",
  low: "low",
}

const SEVERITY_RE = /[([]\s*(?:high|med|medium|low)\s*[)\]]/gi

const TAG_SEARCH_RE = /[([]\s*(high|med|medium|low)\s*[)\]]/i

const TOKEN_RE = /^[A-Za-z0-9._~\-/@\\+]+$/

const EXT_RE = /\.[A-Za-z0-9]{2,12}$/

const FILE_LINE_RE = /^([A-Za-z0-9._~\-/@\\+]+):(\d{1,6})[.,;:)]*$/

const SYNTHETIC_RE = /^(route|url):(.+)$/i

const BULLET_RE = /^(?:\s*(?:[-*+]|\d+[.)])\s*)+/

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function looksLikePath(token: string): boolean {
  if (!TOKEN_RE.test(token) || token.length < 3) return false
  if (token.includes("/") || token.includes("\\")) return true
  return EXT_RE.test(token) && !token.startsWith(".")
}

function remainder(text: string, token: string): string {
  return collapse(text.replace(token, " "))
    .replace(/^[-–—:;,.]+\s*/, "")
    .trim()
}

function parseLocation(text: string): { location: string; key: string; rest: string } | null {
  for (const token of text.split(/\s+/)) {
    const synthetic = token.match(SYNTHETIC_RE)
    if (synthetic?.[1] && synthetic[2]) {
      const value = synthetic[2].replace(/[.,;:)\]]+$/, "")
      const location = `${synthetic[1].toLowerCase()}:${value}`
      return { location, key: location.toLowerCase(), rest: remainder(text, token) }
    }
    const fileLine = token.match(FILE_LINE_RE)
    if (fileLine?.[1] && fileLine[2] && looksLikePath(fileLine[1])) {
      return { location: token, key: fileLine[1].toLowerCase(), rest: remainder(text, token) }
    }
    if (looksLikePath(token)) {
      return { location: token, key: token.toLowerCase(), rest: remainder(text, token) }
    }
  }
  return null
}

export function parseFindingLine(line: string): ParsedFinding | null {
  const withoutBullet = collapse(line.replace(BULLET_RE, "").replace(/`/g, ""))
  if (!withoutBullet) return null
  let severity: Severity = "low"
  let tagged = false
  const tagMatch = TAG_SEARCH_RE.exec(withoutBullet)
  if (tagMatch?.[1]) {
    severity = SEVERITY_TAGS[tagMatch[1].toLowerCase()] ?? "low"
    tagged = true
  }
  const withoutTag = collapse(withoutBullet.replace(SEVERITY_RE, " "))
  const loc = parseLocation(withoutTag)
  if (!loc) {
    return {
      severity,
      location: "",
      key: withoutTag.toLowerCase(),
      issue: withoutTag,
      structured: false,
      tagged,
    }
  }
  return {
    severity,
    location: loc.location,
    key: loc.key,
    issue: loc.rest || withoutTag,
    structured: true,
    tagged,
  }
}

export function findingIdentity(raw: string): string {
  const parsed = parseFindingLine(raw)
  if (!parsed || !parsed.structured) return collapse(raw).toLowerCase()
  return `${parsed.key}#${parsed.issue.toLowerCase().slice(0, 60)}`
}

export function severityRank(severity: string): number {
  switch (severity) {
    case "high":
      return 2
    case "med":
      return 1
    default:
      return 0
  }
}

export function extractFindings(reportText: string): string[] {
  const out: string[] = []
  let inSections = false
  let findingIndent: number | null = null
  for (const raw of reportText.split("\n")) {
    const indentMatch = raw.match(/^[ \t]*/)
    const indent = indentMatch ? indentMatch[0].length : 0
    const line = raw.replace(/^[ \t]+/, "")
    if (line.startsWith("## ")) {
      inSections = true
      findingIndent = null
      continue
    }
    if (!inSections || !line || line.startsWith("#") || line.startsWith(">")) continue
    const bullet = line.match(/^(?:-|\d+\.)\s+(.*)$/)
    if (!bullet?.[1]) continue
    const finding = bullet[1].replace(/\s+/g, " ").trim()
    if (findingIndent !== null && indent > findingIndent) continue
    if (/^evidence:/i.test(finding) || /^note:/i.test(finding)) continue
    if (/^no findings[.!]?\s*$/i.test(finding)) continue
    findingIndent = indent
    out.push(finding)
  }
  return out
}

export function deltaReports(previous: AuditSnapshot | null, currentReport: string): {
  newFindings: string[]
  resolvedCount: number
  total: number
} {
  const current = [...new Set(extractFindings(currentReport))]
  const prevSet = new Set((previous?.findings ?? []).map((f) => findingIdentity(f)))
  const currentWithIdentity = current.map((f) => ({ raw: f, identity: findingIdentity(f) }))
  const currIdentities = new Set(currentWithIdentity.map((f) => f.identity))
  return {
    newFindings: currentWithIdentity
      .filter((f) => !prevSet.has(f.identity))
      .map((f) => f.raw),
    resolvedCount: previous
      ? previous.findings.filter((f) => !currIdentities.has(findingIdentity(f))).length
      : 0,
    total: current.length,
  }
}

export function renderDeltaFooter(
  d: { newFindings: string[]; resolvedCount: number; total: number },
  previousTime: string | null,
): string {
  if (!previousTime) return "> first run — no baseline yet"
  const since = ` since last run (${previousTime})`
  return `> 🆕 ${d.newFindings.length} new · ${d.resolvedCount} resolved · ${d.total} total findings${since}`
}
