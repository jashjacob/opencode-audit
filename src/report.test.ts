import { strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import type { ProbeResult } from "./orchestrator.js"
import type { Playbook, Probe } from "./playbooks.js"
import { renderReport } from "./report.js"

const PLAYBOOK: Playbook = { id: "seo", description: "test", probes: [] }

const PROBE: Probe = {
  name: "routes",
  agent: "explore",
  system: "",
  prompt: (target) => target,
}

function render(text: string): string {
  const results: ProbeResult[] = [{ probe: PROBE, text }]
  return renderReport(PLAYBOOK, results, "/tmp/project")
}

describe("renderReport", () => {
  it("renders findings at depth 1 and evidence at depth 2", () => {
    const out = render(
      [
        "- [high] src/app/page.tsx:12 — missing canonical link",
        "  - evidence: grep 'rel=\"canonical\"' src/app/page.tsx → 0 matches",
        "- [med] route:/checkout — sitemap entry missing",
      ].join("\n"),
    )
    const lines = out.split("\n")
    strictEqual(lines.includes("  - [high] src/app/page.tsx:12 — missing canonical link"), true)
    strictEqual(lines.includes("    - evidence: grep 'rel=\"canonical\"' src/app/page.tsx → 0 matches"), true)
    strictEqual(lines.includes("  - [med] route:/checkout — sitemap entry missing"), true)
  })

  it("renders same-indent evidence:-prefixed bullets at depth 2", () => {
    const out = render(
      [
        "- [high] src/app/page.tsx:12 — missing canonical link",
        "- evidence: grep returned 0 matches",
      ].join("\n"),
    )
    strictEqual(out.split("\n").includes("    - evidence: grep returned 0 matches"), true)
  })

  it("renders indented continuation text under a finding as evidence", () => {
    const out = render(
      [
        "- [high] src/app/page.tsx:12 — missing canonical link",
        "    grep 'rel=\"canonical\"' returned 0 matches",
      ].join("\n"),
    )
    strictEqual(
      out.split("\n").includes("    - grep 'rel=\"canonical\"' returned 0 matches"),
      true,
    )
  })

  it("renders Note: lines as blockquotes", () => {
    const out = render(
      [
        "- [med] route:/checkout — sitemap entry missing",
        "Note: could not verify pagination",
        "- Note: bullet-form note line here",
      ].join("\n"),
    )
    const lines = out.split("\n")
    strictEqual(lines.includes("> Note: could not verify pagination"), true)
    strictEqual(lines.includes("> Note: bullet-form note line here"), true)
  })

  it("does not count severity tags inside evidence or note lines", () => {
    const out = render(
      [
        "- [med] src/app/page.tsx:12 — missing canonical link",
        "  - evidence: grep \"[high]\" src/app/page.tsx → 0 matches",
        "Note: [high] could not verify pagination",
      ].join("\n"),
    )
    strictEqual(out.includes("> severity counts: high 0, med 1, low 0"), true)
  })
})
