import fs from "node:fs"
import type { OpencodeClient } from "@opencode-ai/sdk"
import type { ToolDefinition } from "@opencode-ai/plugin/tool"
import { tool } from "@opencode-ai/plugin/tool"
import { createLogger, loadConfig, requireModel, resolveSessionModel } from "./config.js"
import type { ModelRef } from "./config.js"
import { runPlaybook } from "./orchestrator.js"
import { listPlaybooks, resolvePlaybook } from "./playbooks.js"
import { resolveWorktreePath } from "./paths.js"
import { renderReport } from "./report.js"
import { deltaReports, extractFindings, findingIdentity, loadSnapshot, parseFindingLine, renderDeltaFooter, saveSnapshot, severityRank } from "./state.js"

export type FixFleetModule = {
  toolName: string
  tool: ToolDefinition
  command: { description: string; template: string }
}

type SessionPart = {
  type?: string
  text?: string
}

type Verdict = "fixed" | "not-fixed" | "bad-fix" | "needs-human"

type FindingVerdict = {
  finding: string
  verdict: Verdict | "unknown"
  note: string
}

type ClusterVerdict = {
  cluster: number
  findings: FindingVerdict[]
}

type Cluster = {
  index: number
  findings: string[]
  severities: Record<string, number>
}

type DiffEntry = { file: string; additions?: number; deletions?: number }

type FixerResult = {
  sessionID: string
  ok: boolean
  error?: string
  summary: string
  diffFiles: DiffEntry[]
  verdicts: FindingVerdict[]
}

type DiffFile = {
  path?: string
  file?: string
  filename?: string
  additions?: number
  deletions?: number
}

const MAX_FINDINGS = 40
const TARGET_CLUSTER_SIZE = 4

function extractText(reply: unknown): string {
  const r = reply as {
    parts?: SessionPart[]
    data?: { parts?: SessionPart[] }
  }
  const parts = r?.parts ?? r?.data?.parts ?? []
  return parts
    .filter((p) => p?.type === "text" && typeof p?.text === "string")
    .map((p) => (p as { text: string }).text)
    .join("\n")
    .trim()
}

function normalizeFinding(line: string): string {
  return line.replace(/^\s*(?:-\s+|\d+[.)]\s+)/, "").replace(/\s+/g, " ").trim()
}

export type ReportEntry = { finding: string; evidence: string[] }

export function parseReportEntries(report: string): ReportEntry[] {
  const seen = new Map<string, number>()
  const findings: { raw: string; severity: string; structured: boolean; order: number; evidence: string[] }[] = []
  let findingIndent: number | null = null
  let currentIndex: number | null = null
  for (const rawLine of report.split("\n")) {
    const indentMatch = rawLine.match(/^[ \t]*/)
    const indent = indentMatch ? indentMatch[0].length : 0
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith("#")) {
      if (line.startsWith("## ")) {
        findingIndent = null
        currentIndex = null
      }
      continue
    }
    if (line.startsWith(">")) continue
    const isBullet = /^(?:-\s+|\d+[.)]\s+)/.test(line)
    if (isBullet && /^-(?:\s*)(target|time|report|findings|clusters):/i.test(line)) continue
    const content = isBullet ? normalizeFinding(line) : line.replace(/\s+/g, " ").trim()
    if (/^note:/i.test(content)) continue
    if (/^evidence:/i.test(content) || (isBullet && findingIndent !== null && indent > findingIndent)) {
      const entry = currentIndex !== null ? findings[currentIndex] : undefined
      if (entry && entry.evidence.length < 3) entry.evidence.push(content)
      continue
    }
    if (!isBullet) continue
    const finding = content
    if (!finding || finding.length < 8) continue
    if (/^no findings[.!]?\s*$/i.test(finding)) continue
    const parsed = parseFindingLine(finding)
    const severity = parsed?.severity ?? "low"
    const structured = parsed?.structured ?? false
    const key = parsed && parsed.structured ? findingIdentity(finding) : finding.toLowerCase()
    findingIndent = indent
    const existing = seen.get(key)
    if (existing !== undefined) {
      currentIndex = existing
      continue
    }
    if (findings.length >= MAX_FINDINGS) {
      currentIndex = null
      continue
    }
    seen.set(key, findings.length)
    currentIndex = findings.length
    findings.push({ raw: finding, severity, structured, order: findings.length, evidence: [] })
  }
  return findings
    .sort((a, b) => {
      const rankDiff = severityRank(b.severity) - severityRank(a.severity)
      if (rankDiff !== 0) return rankDiff
      if (a.structured !== b.structured) return a.structured ? -1 : 1
      return a.order - b.order
    })
    .map((entry) => ({ finding: entry.raw, evidence: entry.evidence }))
}

export function parseFindings(report: string): string[] {
  return parseReportEntries(report).map((entry) => entry.finding)
}

function severityMix(findings: string[]): Record<string, number> {
  const mix: Record<string, number> = { high: 0, med: 0, low: 0 }
  for (const f of findings) {
    const severity = parseFindingLine(f)?.severity ?? "low"
    mix[severity] = (mix[severity] ?? 0) + 1
  }
  return mix
}

export function clusterFindings(findings: string[], maxClusters: number): Cluster[] {
  if (findings.length === 0) return []
  const clusterCount = Math.max(
    1,
    Math.min(maxClusters, Math.ceil(findings.length / TARGET_CLUSTER_SIZE)),
  )
  const perCluster = Math.ceil(findings.length / clusterCount)
  const clusters: Cluster[] = []
  for (let i = 0; i < findings.length; i += perCluster) {
    const slice = findings.slice(i, i + perCluster)
    clusters.push({
      index: clusters.length + 1,
      findings: slice,
      severities: severityMix(slice),
    })
  }
  return clusters
}

function clusterLocationKeys(cluster: Cluster): Set<string> {
  const keys = new Set<string>()
  for (const finding of cluster.findings) {
    const parsed = parseFindingLine(finding)
    if (parsed?.structured && parsed.key) keys.add(parsed.key)
  }
  return keys.size > 0 ? keys : new Set(["*"])
}

export function groupIndependentClusters(clusters: Cluster[]): Cluster[][] {
  const batches: Cluster[][] = []
  const keysByCluster = new Map<Cluster, Set<string>>()
  for (const cluster of clusters) {
    const keys = clusterLocationKeys(cluster)
    keysByCluster.set(cluster, keys)
    let batch = batches.find((candidate) => candidate.every((other) => {
      const otherKeys = keysByCluster.get(other)
      if (!otherKeys) return false
      if (keys.has("*") || otherKeys.has("*")) return false
      return [...keys].every((key) => !otherKeys.has(key))
    }))
    if (!batch) {
      batch = []
      batches.push(batch)
    }
    batch.push(cluster)
  }
  return batches
}

function formatEvidence(evidence: string): string {
  return /^evidence:/i.test(evidence) ? evidence : `evidence: ${evidence}`
}

function numberedFindings(findings: string[], evidence: Map<string, string[]>): string[] {
  const body: string[] = []
  findings.forEach((finding, i) => {
    body.push(`${i + 1}. ${finding}`)
    for (const e of evidence.get(finding) ?? []) {
      body.push(`   ${formatEvidence(e)}`)
    }
  })
  return body
}

export type FixerPromptOptions = {
  directory: string
  playbook: string
  severityMix: Record<string, number>
  findings: string[]
  evidence: Map<string, string[]>
  reportPath: string
}

export function buildFixerPrompt(opts: FixerPromptOptions): string {
  const mix = opts.severityMix
  return [
    `Project directory: ${opts.directory}`,
    `Playbook: ${opts.playbook}`,
    `Severity mix: high ${mix.high ?? 0}, med ${mix.med ?? 0}, low ${mix.low ?? 0}`,
    "Fix exactly these findings:",
    ...numberedFindings(opts.findings, opts.evidence),
    "",
    `Full report with additional context: ${opts.reportPath}`,
    "",
    "End with the numbered finding → action summary.",
  ].join("\n")
}

export type ValidatorPromptOptions = {
  directory: string
  findings: string[]
  evidence: Map<string, string[]>
  fixerSummary: string
  changedFiles: string
  reportPath: string
}

export function buildValidatorPrompt(opts: ValidatorPromptOptions): string {
  return [
    `Project directory: ${opts.directory}`,
    "Verify each finding is now resolved:",
    ...numberedFindings(opts.findings, opts.evidence),
    "",
    "Fixer summary (claims — verify, do not trust):",
    opts.fixerSummary,
    "",
    `Files changed by the fixer: ${opts.changedFiles}`,
    "",
    `Full report with additional context: ${opts.reportPath}`,
  ].join("\n")
}

function fixerSystem(): string {
  return [
    "You are a senior engineer operating in the project directory given in the user message.",
    "Fix ONLY the findings explicitly listed in the user message.",
    "Before editing anything, read the file and line each finding points to and confirm it is real.",
    "Evidence lines listed under a finding are the probe's proof; use them to locate the issue, but still verify the finding is real before editing.",
    "If a finding is wrong or already fixed, change nothing for it and mark it 'invalid' or 'already fixed'.",
    "If a correct fix for one finding would require touching more than 5 files, or a design or product decision you cannot make, mark that finding 'needs-human' and state exactly what is required.",
    "Limit edits to the files involved in the findings. Minimal diffs, no drive-by refactors, no reformatting, no commits.",
    "If package.json defines typecheck, lint, build, or test scripts, run the ones affected by your changed files, fix regressions you caused, and report each command's result; if none are configured, say so.",
    "End your reply with a numbered summary, one line per finding: '<n>. <fixed|already fixed|invalid|needs-human>: <file edited, or reason>'.",
    "These summary labels are for your reply only; a separate validator will re-check every finding independently.",
  ].join(" ")
}

function validatorSystem(): string {
  return [
    "You are a read-only validator agent. DO NOT write, edit, delete, or create any files.",
    "The user message lists numbered findings, the fixer's claimed summary, and the files the fixer changed.",
    "The fixer's claims may be wrong: verify EVERY finding independently against the current state of the project — read the files, do not trust the summary.",
    "Reply with exactly one line per finding, using the same numbering as the user message: '<n>. <verdict>: <one sentence>'.",
    "Verdicts: fixed — the problem no longer exists and the change is complete.",
    "not-fixed — the problem still exists or is only partially addressed.",
    "bad-fix — the change introduced a NEW problem (regression, removed needed code, broken reference).",
    "needs-human — the problem still exists and the fixer's deferral reason is real (design decision, scope beyond the fixer).",
    "unknown — you could not verify; state what blocked you.",
    "If the fixer claims a finding is 'invalid', 'already fixed', or 'needs-human', check that claim against the code; accept it only if it holds, otherwise use not-fixed or bad-fix and say why.",
    "Also check the changed-files list for regressions in files adjacent to the fixes and report any in the relevant line's note.",
  ].join(" ")
}

export function parseVerdicts(text: string, findings: string[]): FindingVerdict[] {
  const map = new Map<number, { verdict: Verdict | "unknown"; note: string }>()
  for (const raw of text.split("\n")) {
    const match = raw.match(/^\s*(\d+)[.)]\s*(fixed|not-fixed|bad-fix|needs-human|unknown)\b[:\s]*(.*)/i)
    if (!match) continue
    const n = Number(match[1])
    const verdict = match[2]?.toLowerCase() as Verdict | "unknown"
    const note = (match[3] ?? "").trim()
    if (!Number.isFinite(n) || !map.has(n)) map.set(n, { verdict, note })
  }
  return findings.map((finding, i) => {
    const entry = map.get(i + 1)
    return {
      finding,
      verdict: entry?.verdict ?? "unknown",
      note: entry?.note ?? "",
    }
  })
}

function extractDiffFiles(reply: unknown): { file: string; additions?: number; deletions?: number }[] {
  const candidates: unknown[] = Array.isArray(reply)
    ? reply
    : Array.isArray((reply as { data?: unknown })?.data)
      ? ((reply as { data: unknown[] }).data)
      : Array.isArray((reply as { data?: { files?: unknown } })?.data?.files)
        ? ((reply as { data: { files: unknown[] } }).data.files)
        : Array.isArray((reply as { files?: unknown })?.files)
          ? ((reply as { files: unknown[] }).files)
          : []
  return candidates
    .map((entry) => {
      const f = entry as DiffFile
      const file = f?.path ?? f?.filename ?? f?.file ?? ""
      if (typeof file !== "string" || file.length === 0) return null
      const out: { file: string; additions?: number; deletions?: number } = { file }
      if (typeof f?.additions === "number") out.additions = f.additions
      if (typeof f?.deletions === "number") out.deletions = f.deletions
      return out
    })
    .filter((f): f is { file: string; additions?: number; deletions?: number } => f !== null)
}

async function runSession(
  client: OpencodeClient,
  opts: {
    title: string
    agent: "general" | "explore"
    system: string
    prompt: string
    directory: string
    model: { providerID: string; modelID: string } | null
  },
): Promise<{ text: string; sessionID: string; diffFiles: DiffEntry[] }> {
  let sessionID: string | undefined
  try {
    const created = await client.session.create({
      body: { title: opts.title },
      query: { directory: opts.directory },
    })
    sessionID = created?.data?.id
    if (!sessionID) throw new Error("session.create returned no id")

    const reply = await client.session.prompt({
      path: { id: sessionID },
      query: { directory: opts.directory },
      body: {
        agent: opts.agent,
        system: opts.system,
        parts: [{ type: "text", text: opts.prompt }],
        ...(opts.model ? { model: opts.model } : {}),
      },
    })
    const text = extractText(reply)
    if (!text) throw new Error("session returned no assistant text")

    let diffFiles: DiffEntry[] = []
    try {
      const diff = await client.session.diff({ path: { id: sessionID } })
      diffFiles = extractDiffFiles(diff)
    } catch {
      diffFiles = []
    }
    return { text, sessionID, diffFiles }
  } finally {
    if (sessionID) {
      await client.session.delete({ path: { id: sessionID }, query: { directory: opts.directory } }).catch(() => {})
    }
  }
}

async function runCluster(
  client: OpencodeClient,
  cluster: Cluster,
  playbook: string,
  directory: string,
  model: { providerID: string; modelID: string } | null,
  evidence: Map<string, string[]>,
  reportPath: string,
): Promise<FixerResult> {
  const base: FixerResult = {
    sessionID: "",
    ok: false,
    summary: "",
    diffFiles: [],
    verdicts: cluster.findings.map((finding) => ({ finding, verdict: "unknown", note: "" })),
  }
  try {
    const fixerPrompt = buildFixerPrompt({
      directory,
      playbook,
      severityMix: cluster.severities,
      findings: cluster.findings,
      evidence,
      reportPath,
    })

    const fixer = await runSession(client, {
      title: `fix:${playbook}:${cluster.index}`,
      agent: "general",
      system: fixerSystem(),
      prompt: fixerPrompt,
      directory,
      model,
    })

    const filesText = fixer.diffFiles.length > 0
      ? fixer.diffFiles.map((f) => f.file).join(", ")
      : "none recorded"
    const validatorPrompt = buildValidatorPrompt({
      directory,
      findings: cluster.findings,
      evidence,
      fixerSummary: fixer.text.trim(),
      changedFiles: filesText,
      reportPath,
    })

    const validator = await runSession(client, {
      title: `validate:${playbook}:${cluster.index}`,
      agent: "explore",
      system: validatorSystem(),
      prompt: validatorPrompt,
      directory,
      model,
    }).catch(() => null)

    const verdicts = validator
      ? parseVerdicts(validator.text, cluster.findings)
      : cluster.findings.map((finding) => ({ finding, verdict: "unknown" as const, note: "validator failed" }))
    return {
      sessionID: fixer.sessionID,
      ok: true,
      summary: fixer.text,
      diffFiles: fixer.diffFiles,
      verdicts,
    }
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
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

function renderVerdict(verdicts: ClusterVerdict[]): string {
  const counts: Record<Verdict | "unknown", number> = {
    fixed: 0,
    "not-fixed": 0,
    "bad-fix": 0,
    "needs-human": 0,
    unknown: 0,
  }
  for (const cluster of verdicts) {
    for (const f of cluster.findings) counts[f.verdict]++
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  return [
    "## Verdict",
    "",
    `- fixed: ${counts.fixed}/${total}`,
    `- not-fixed: ${counts["not-fixed"]}/${total}`,
    `- bad-fix: ${counts["bad-fix"]}/${total}`,
    `- needs-human: ${counts["needs-human"]}/${total}`,
    `- unknown: ${counts.unknown}/${total}`,
    "",
    ...verdicts.flatMap((c) => [
      `### cluster ${c.cluster}`,
      ...c.findings.map((f) => `- ${f.verdict}: ${f.finding}${f.note ? ` — ${f.note}` : ""}`),
    ]),
  ].join("\n")
}

type ReauditResult = {
  section: string
  delta: { newFindings: number; resolved: number; total: number; footer: string } | null
}

async function runReaudit(
  client: OpencodeClient,
  playbookId: string,
  worktree: string,
  config: ReturnType<typeof loadConfig>,
  fleetModel: ModelRef,
  directory: string,
  parentSessionID: string,
): Promise<ReauditResult> {
  const fail = (message: string): ReauditResult => ({
    section: ["## Re-audit", "", `> re-audit failed: ${message}`, "(previous baseline kept)"].join("\n"),
    delta: null,
  })
  try {
    const playbook = resolvePlaybook(playbookId)
    const previous = loadSnapshot(playbook.id, worktree)
    const results = await runPlaybook(
      client,
      playbook,
      worktree,
      { ...config, model: fleetModel },
      directory,
      parentSessionID,
    )
    if (results.length === 0 || results.some((r) => r.error)) {
      return fail("some probes failed; previous baseline kept")
    }
    const report = renderReport(playbook, results, worktree)
    const delta = deltaReports(previous, report)
    const footer = renderDeltaFooter(delta, previous?.time ?? null)
    saveSnapshot({
      playbook: playbook.id,
      target: worktree,
      time: new Date().toISOString(),
      findings: extractFindings(report),
    })
    const section = [
      "## Re-audit",
      "",
      footer,
      "",
      `- new findings: ${delta.newFindings.length}`,
      `- resolved: ${delta.resolvedCount}`,
      `- total findings: ${delta.total}`,
      "",
      ...(delta.newFindings.length > 0 ? ["### new findings", ...delta.newFindings.map((f) => `- ${f}`)] : []),
    ].join("\n")
    return { section, delta: { newFindings: delta.newFindings.length, resolved: delta.resolvedCount, total: delta.total, footer } }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}

export function createFixFleet(client: OpencodeClient): FixFleetModule {
  const fixFleetTool = tool({
    description:
      "Parse an audit report, dedupe and cluster findings, run parallel fixer agents with a read-only validator per cluster, and merge the verdicts.",
    args: {
      playbook: tool.schema.enum(listPlaybooks() as [string, ...string[]]),
      report: tool.schema
        .string()
        .optional()
        .describe("Path to the audit report; defaults to AUDIT-<playbook>.md in the worktree"),
      dry_run: tool.schema
        .boolean()
        .optional()
        .describe("Only plan the clusters without spawning fixers"),
      max_fixers: tool.schema
        .number()
        .optional()
        .describe("Maximum concurrent fixer clusters (1-8, default 4)"),
      revalidate: tool.schema
        .boolean()
        .optional()
        .describe("re-run the audit probes after fixing to refresh the delta baseline"),
    },
    async execute(args, ctx) {
      const config = loadConfig()
      const log = createLogger(config.debug)
      const dryRun = args.dry_run ?? false
      const maxFixers = Math.min(8, Math.max(1, Math.floor(args.max_fixers ?? 4)))

      if (ctx.abort.aborted) {
        throw new Error("fix fleet aborted before start")
      }
      ctx.abort.addEventListener("abort", () => log.info("fix fleet aborted"), { once: true })

      const reportPath = resolveWorktreePath(
        ctx.worktree,
        args.report ?? `AUDIT-${args.playbook}.md`,
      )

      let reportText: string
      try {
        reportText = fs.readFileSync(reportPath, "utf8")
      } catch {
        return {
          title: `fix: ${args.playbook}`,
          output: `No audit report found at \`${reportPath}\`. Run the audit_fleet tool first, or pass \`report\` pointing to an existing report.`,
          metadata: { clusters: [], fixers: [], verdict: null },
        }
      }

      const entries = parseReportEntries(reportText)
      if (entries.length === 0) {
        return {
          title: `fix: ${args.playbook}`,
          output: `No findings found in \`${reportPath}\`. Run the audit_fleet tool first, or pass \`report\` pointing to a report with findings.`,
          metadata: { clusters: [], fixers: [], verdict: null },
        }
      }

      const findings = entries.map((entry) => entry.finding)
      const evidenceByFinding = new Map<string, string[]>()
      for (const entry of entries) {
        if (entry.evidence.length > 0) evidenceByFinding.set(entry.finding, entry.evidence)
      }

      const clusters = clusterFindings(findings, maxFixers)
      log.info(`fix fleet "${args.playbook}": ${findings.length} findings in ${clusters.length} clusters`)

      if (dryRun) {
        const plan = [
          `# fix plan: ${args.playbook} (dry run)`,
          "",
          `- report: \`${reportPath}\``,
          `- findings: ${findings.length}`,
          `- clusters: ${clusters.length}`,
          "",
          ...clusters.flatMap((c) => [
            `## cluster ${c.index}`,
            ...c.findings.flatMap((f) => [
              `- ${f}`,
              ...(evidenceByFinding.get(f) ?? []).map((e) => `  - ${formatEvidence(e)}`),
            ]),
          ]),
          "",
          "## fixer instructions",
          `- ${fixerSystem()}`,
        ].join("\n")
        return {
          title: `fix: ${args.playbook}`,
          output: plan,
          metadata: { clusters, fixers: [], verdict: null },
        }
      }

      await ctx.ask({
        permission: "fix_fleet",
        patterns: [args.playbook],
        always: [],
        metadata: { playbook: args.playbook, clusters: clusters.length, dryRun },
      })

      const fleetModel = requireModel(
        ctx.sessionID,
        config.model ?? (await resolveSessionModel(client, ctx.sessionID)),
      )
      const results: FixerResult[] = new Array(clusters.length)
      for (const batch of groupIndependentClusters(clusters)) {
        const batchResults = await mapWithConcurrency(batch, maxFixers, (cluster) => {
          if (ctx.abort.aborted) {
            return Promise.resolve<FixerResult>({
              sessionID: "",
              ok: false,
              error: "aborted before cluster started",
              summary: "",
              diffFiles: [],
              verdicts: cluster.findings.map((finding) => ({ finding, verdict: "unknown", note: "" })),
            })
          }
          return runCluster(client, cluster, args.playbook, ctx.directory, fleetModel, evidenceByFinding, reportPath)
        })
        batch.forEach((cluster, index) => {
          results[cluster.index - 1] = batchResults[index] as FixerResult
        })
      }

      const verdicts: ClusterVerdict[] = clusters.map((c, i) => ({
        cluster: c.index,
        findings: results[i]?.verdicts ?? c.findings.map((finding) => ({ finding, verdict: "unknown", note: "" })),
      }))

      const fixers = results.map((r, i) => ({
        sessionID: r.sessionID,
        ok: r.ok,
        ...(r.error ? { error: r.error } : {}),
        summary: r.ok ? r.summary : r.error ?? "",
      }))

      const fileLines = results.flatMap((r, i) =>
        r.diffFiles.map((f) => {
          const stat = f.additions !== undefined || f.deletions !== undefined
            ? ` (+${f.additions ?? 0}/-${f.deletions ?? 0})`
            : ""
          return `- cluster ${i + 1}: ${f.file}${stat}`
        }),
      )

      const output = [
        `# fix fleet: ${args.playbook}`,
        "",
        `- report: \`${reportPath}\``,
        `- findings: ${findings.length} in ${clusters.length} clusters`,
        "",
        "## Clusters",
        ...clusters.map(
          (c) =>
            `- cluster ${c.index}: ${c.findings.length} findings, fixer ${results[c.index - 1]?.ok ? "ok" : "failed"}`,
        ),
        "",
        "## Files changed",
        ...(fileLines.length > 0 ? fileLines : ["- none recorded"]),
        "",
        renderVerdict(verdicts),
      ].join("\n")

      const sections = [output]

      const revalidate = args.revalidate ?? false
      let reaudit: { newFindings: number; resolved: number; total: number; footer: string } | null = null
      if (revalidate && !ctx.abort.aborted) {
        const reauditResult = await runReaudit(
          client,
          args.playbook,
          ctx.worktree,
          config,
          fleetModel,
          ctx.directory,
          ctx.sessionID,
        )
        sections.push(reauditResult.section)
        reaudit = reauditResult.delta
      }

      const finalOutput = sections.join("\n\n")

      return {
        title: `fix: ${args.playbook}`,
        output: finalOutput,
        metadata: { clusters, fixers, verdict: verdicts, reaudit },
      }
    },
  })

  return {
    toolName: "fix_fleet",
    tool: fixFleetTool as ToolDefinition,
    command: {
      description: "Run the fix fleet on an audit report",
      template:
        "Call the fix_fleet tool with playbook=$1 and report=$2 if given. Optionally pass revalidate=true to re-run the audit probes after fixing and refresh the delta baseline. Summarize fixes and the validator verdict.",
    },
  }
}
