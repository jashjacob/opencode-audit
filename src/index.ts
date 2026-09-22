import fs from "node:fs"
import path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { tool, type ToolContext } from "@opencode-ai/plugin/tool"
import {
  createLogger,
  loadConfig,
  recordSessionModel,
  requireModel,
  resolveSessionModel,
} from "./config.js"
import { createFixFleet } from "./fix-fleet.js"
import { runPlaybook } from "./orchestrator.js"
import { listPlaybooks, resolvePlaybook } from "./playbooks.js"
import { renderReport } from "./report.js"
import {
  deltaReports,
  extractFindings,
  loadSnapshot,
  renderDeltaFooter,
  saveSnapshot,
} from "./state.js"

const AUDIT_NAMES = listPlaybooks()

export default (async ({ client }) => {
  const fixFleet = createFixFleet(client)

  const auditTool = tool({
    description: [
      "Run a standardized, read-only audit. Spawns parallel probe subagents and returns one consolidated markdown report.",
      `Available playbooks: ${AUDIT_NAMES.join(", ")}.`,
      "Use when the user asks to audit dead code, unused CSS, SEO, accessibility, mobile UX, dependencies, migrations, performance, or content.",
    ].join(" "),
    args: {
      playbook: tool.schema.enum(AUDIT_NAMES as [string, ...string[]]),
      target: tool.schema.string().optional().describe("Path or URL to audit; defaults to the project worktree"),
      report: tool.schema.string().optional().describe("Override path to write the report to; defaults to AUDIT-<playbook>.md in the worktree"),
    },
    async execute(args, ctx: ToolContext) {
      const config = loadConfig()
      const log = createLogger(config.debug)
      const target = args.target ?? ctx.worktree
      const probeModel = requireModel(
        ctx.sessionID,
        config.model ?? (await resolveSessionModel(client, ctx.sessionID)),
      )

      log.info(`starting "${args.playbook}" audit against ${target}`)
      const playbook = resolvePlaybook(args.playbook)
      ctx.metadata({ title: `audit: ${args.playbook}` })

      if (ctx.abort.aborted) {
        throw new Error("audit aborted before start")
      }
      ctx.abort.addEventListener("abort", () => log.info("audit aborted"), { once: true })

      const previous = loadSnapshot(playbook.id, target)
      const results = await runPlaybook(
        client,
        playbook,
        target,
        { ...config, model: probeModel },
        ctx.directory,
        ctx.sessionID,
      )
      const report = renderReport(playbook, results, target)
      const delta = deltaReports(previous, report)
      const output = `${report}\n${renderDeltaFooter(delta, previous?.time ?? null)}`
      if (results.some((r) => !r.error)) {
        saveSnapshot({
          playbook: playbook.id,
          target,
          time: new Date().toISOString(),
          findings: extractFindings(report),
        })
      }

      const probeMeta = results.map((r) => ({
        name: r.probe.name,
        agent: r.probe.agent,
        error: r.error ?? null,
      }))
      const deltaMeta = {
        new: delta.newFindings.length,
        resolved: delta.resolvedCount,
        total: delta.total,
      }

      let reportPath: string | null = null
      if (config.writeReport || args.report) {
        const outPath = path.resolve(ctx.worktree, args.report ?? `AUDIT-${args.playbook}.md`)
        fs.mkdirSync(path.dirname(outPath), { recursive: true })
        fs.writeFileSync(outPath, output, "utf8")
        reportPath = outPath
        log.info(`wrote report to ${outPath}`)
      }

      return {
        title: `audit: ${args.playbook}`,
        output,
        metadata: {
          probes: probeMeta,
          delta: deltaMeta,
          ...(reportPath ? { report: reportPath } : {}),
        },
      }
    },
  })

  return {
    tool: { audit_fleet: auditTool, [fixFleet.toolName]: fixFleet.tool },
    "chat.message": async (input) => {
      recordSessionModel(input.sessionID, input.model)
    },
    config: async (cfg) => {
      cfg.command = {
        ...cfg.command,
        audit: {
          description: "Run a parallel subagent audit playbook",
          template: [
            `Call the audit_fleet tool with the playbook from $ARGUMENTS.`,
            `Available playbooks: ${AUDIT_NAMES.join(", ")}.`,
            "Summarize the report and propose a todo list of fixes.",
          ].join(" "),
        },
        fix: {
          description: fixFleet.command.description,
          template: fixFleet.command.template,
        },
      }
    },
  }
}) satisfies Plugin