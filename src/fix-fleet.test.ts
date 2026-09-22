import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { buildFixerPrompt, buildValidatorPrompt, clusterFindings, parseFindings, parseReportEntries, parseVerdicts } from "./fix-fleet.js"
import { extractFindings } from "./state.js"

describe("parseFindings", () => {
  const REPORT = [
    "# Audit Report",
    "",
    "- target: /Users/dev/project",
    "- time: 2026-09-18T10:00:00Z",
    "- report: AUDIT-css.md",
    "- findings: 3",
    "- clusters: 2",
    "- TARGET: uppercase metadata should be skipped",
    "",
    "> blockquote line that looks like - not a bullet prefix so kept out via '>' check",
    "",
    "## probe (unused-css)",
    "",
    "  - Unused class `.legacy-card` in styles/main.css",
    "  1. Orphaned selector `.footer-nav` in layout.css",
    "  2) Parenthesis numbered finding in layout.css",
    "",
    "## probe (css-size)",
    "",
    "  - Duplicated rule block in components.css",
  ].join("\n")

  it("extracts bullet and numbered findings, skipping headers, blockquotes and metadata lines", () => {
    const findings = parseFindings(REPORT)
    deepStrictEqual(findings, [
      "Unused class `.legacy-card` in styles/main.css",
      "Orphaned selector `.footer-nav` in layout.css",
      "Parenthesis numbered finding in layout.css",
      "Duplicated rule block in components.css",
    ])
  })

  it("skips metadata lines case-insensitively", () => {
    const findings = parseFindings(REPORT)
    strictEqual(findings.some((f) => f.toLowerCase().startsWith("target:")), false)
    strictEqual(findings.some((f) => f.toLowerCase().startsWith("time:")), false)
    strictEqual(findings.some((f) => f.toLowerCase().startsWith("report:")), false)
    strictEqual(findings.some((f) => f.toLowerCase().startsWith("findings:")), false)
    strictEqual(findings.some((f) => f.toLowerCase().startsWith("clusters:")), false)
  })

  it("dedupes case-insensitively", () => {
    const findings = parseFindings("- Duplicate Finding Text Here\n- duplicate finding text here")
    deepStrictEqual(findings, ["Duplicate Finding Text Here"])
  })

  it("drops findings shorter than 8 characters after normalization", () => {
    const findings = parseFindings("- abcdefg\n- abcdefgh\n- 1. xy")
    deepStrictEqual(findings, ["abcdefgh"])
  })

  it("caps results at MAX_FINDINGS (40)", () => {
    const lines: string[] = []
    for (let i = 1; i <= 50; i++) {
      lines.push(`- finding number ${String(i).padStart(3, "0")} with detail`)
    }
    const findings = parseFindings(lines.join("\n"))
    strictEqual(findings.length, 40)
    strictEqual(findings[0], "finding number 001 with detail")
    strictEqual(findings[39], "finding number 040 with detail")
  })

  it("returns [] for reports without bullets", () => {
    deepStrictEqual(parseFindings("# header\n\n> quote\n\nplain text"), [])
  })

  it("never returns evidence or Note lines as findings", () => {
    const report = [
      "## probe (a)",
      "",
      "  - [high] src/app/page.tsx:12 — missing canonical link",
      "    - evidence: grep 'rel=\"canonical\"' src/app/page.tsx → 0 matches",
      "  - [med] route:/checkout — sitemap entry missing",
      "- evidence: same indent proof line here",
      "- Note: could not verify pagination",
    ].join("\n")
    deepStrictEqual(parseFindings(report), [
      "[high] src/app/page.tsx:12 — missing canonical link",
      "[med] route:/checkout — sitemap entry missing",
    ])
  })
})

describe("parseReportEntries", () => {
  it("attaches deeper-indent evidence bullets to the preceding finding", () => {
    const report = [
      "## probe (routes)",
      "",
      "  - [high] src/app/page.tsx:12 — missing canonical link",
      "    - evidence: grep 'rel=\"canonical\"' src/app/page.tsx → 0 matches",
      "    - grep scan of head elements returned nothing",
      "  - [med] route:/checkout — sitemap entry missing",
    ].join("\n")
    const entries = parseReportEntries(report)
    deepStrictEqual(entries.map((e) => e.finding), [
      "[high] src/app/page.tsx:12 — missing canonical link",
      "[med] route:/checkout — sitemap entry missing",
    ])
    deepStrictEqual(entries[0]?.evidence, [
      "evidence: grep 'rel=\"canonical\"' src/app/page.tsx → 0 matches",
      "grep scan of head elements returned nothing",
    ])
    deepStrictEqual(entries[1]?.evidence, [])
  })

  it("attaches same-indent evidence:-prefixed bullets to the preceding finding", () => {
    const report = [
      "- [high] src/app/page.tsx:12 — missing canonical link",
      "- evidence: grep 'rel=\"canonical\"' src/app/page.tsx → 0 matches",
    ].join("\n")
    const entries = parseReportEntries(report)
    strictEqual(entries.length, 1)
    deepStrictEqual(entries[0]?.evidence, ["evidence: grep 'rel=\"canonical\"' src/app/page.tsx → 0 matches"])
  })

  it("caps evidence at 3 lines per finding", () => {
    const report = [
      "- [high] src/a.ts:1 — issue with enough length",
      "  - evidence: first check result",
      "  - evidence: second check result",
      "  - evidence: third check result",
      "  - evidence: fourth check result",
    ].join("\n")
    const entries = parseReportEntries(report)
    strictEqual(entries.length, 1)
    deepStrictEqual(entries[0]?.evidence, [
      "evidence: first check result",
      "evidence: second check result",
      "evidence: third check result",
    ])
  })

  it("drops orphan evidence with no preceding finding", () => {
    const report = [
      "    - evidence: proof before any finding",
      "- [high] src/a.ts:1 — real issue with length",
    ].join("\n")
    const entries = parseReportEntries(report)
    strictEqual(entries.length, 1)
    deepStrictEqual(entries[0]?.evidence, [])
  })

  it("dedupes repeated findings and merges their evidence", () => {
    const report = [
      "- [high] src/a.ts:1 — duplicate issue text",
      "  - evidence: first proof line here",
      "- [med] src/a.ts:1 — duplicate issue text",
      "  - evidence: second proof line here",
    ].join("\n")
    const entries = parseReportEntries(report)
    strictEqual(entries.length, 1)
    deepStrictEqual(entries[0]?.evidence, [
      "evidence: first proof line here",
      "evidence: second proof line here",
    ])
  })

  it("drops Note: lines instead of treating them as findings or evidence", () => {
    const report = [
      "- [med] route:/checkout — sitemap entry missing",
      "  - Note: could not verify pagination",
      "- Note: standalone note line here",
    ].join("\n")
    const entries = parseReportEntries(report)
    strictEqual(entries.length, 1)
    deepStrictEqual(entries[0]?.evidence, [])
  })

  it("drops evidence belonging to findings past the cap", () => {
    const lines: string[] = []
    for (let i = 1; i <= 41; i++) {
      lines.push(`- finding number ${String(i).padStart(3, "0")} with detail`)
      if (i === 41) lines.push("    - evidence: proof for the capped finding")
    }
    const entries = parseReportEntries(lines.join("\n"))
    strictEqual(entries.length, 40)
    strictEqual(entries.some((e) => e.evidence.some((line) => line.includes("capped finding"))), false)
  })
})

describe("buildFixerPrompt", () => {
  it("includes evidence lines and the report path", () => {
    const evidence = new Map([
      ["[high] src/app/page.tsx:12 — missing canonical link", ["evidence: grep 'rel=\"canonical\"' src/app/page.tsx → 0 matches"]],
      ["[med] styles/main.css — duplicated rule block here", ["grep scan of selectors returned nothing"]],
    ])
    const prompt = buildFixerPrompt({
      directory: "/tmp/project",
      playbook: "seo",
      severityMix: { high: 1, med: 1, low: 0 },
      findings: ["[high] src/app/page.tsx:12 — missing canonical link", "[med] styles/main.css — duplicated rule block here"],
      evidence,
      reportPath: "/tmp/project/AUDIT-seo.md",
    })
    strictEqual(prompt.includes("Project directory: /tmp/project"), true)
    strictEqual(prompt.includes("Playbook: seo"), true)
    strictEqual(prompt.includes("Severity mix: high 1, med 1, low 0"), true)
    strictEqual(prompt.includes("1. [high] src/app/page.tsx:12 — missing canonical link"), true)
    strictEqual(prompt.includes("   evidence: grep 'rel=\"canonical\"' src/app/page.tsx → 0 matches"), true)
    strictEqual(prompt.includes("2. [med] styles/main.css — duplicated rule block here"), true)
    strictEqual(prompt.includes("   evidence: grep scan of selectors returned nothing"), true)
    strictEqual(prompt.includes("Full report with additional context: /tmp/project/AUDIT-seo.md"), true)
    strictEqual(prompt.includes("End with the numbered finding → action summary."), true)
  })

  it("renders findings without evidence as bare numbered lines", () => {
    const prompt = buildFixerPrompt({
      directory: "/tmp/project",
      playbook: "css",
      severityMix: { high: 0, med: 1, low: 0 },
      findings: ["[med] styles/main.css — duplicated rule block here"],
      evidence: new Map(),
      reportPath: "/tmp/project/AUDIT-css.md",
    })
    strictEqual(prompt.includes("1. [med] styles/main.css — duplicated rule block here\n"), true)
    strictEqual(prompt.includes("   evidence:"), false)
  })
})

describe("buildValidatorPrompt", () => {
  it("includes evidence lines, claims label, changed files and report path", () => {
    const evidence = new Map([
      ["[high] src/app/page.tsx:12 — missing canonical link", ["evidence: grep returned 0 matches"]],
    ])
    const prompt = buildValidatorPrompt({
      directory: "/tmp/project",
      findings: ["[high] src/app/page.tsx:12 — missing canonical link"],
      evidence,
      fixerSummary: "1. fixed: added canonical link",
      changedFiles: "src/app/page.tsx",
      reportPath: "/tmp/project/AUDIT-seo.md",
    })
    strictEqual(prompt.includes("Project directory: /tmp/project"), true)
    strictEqual(prompt.includes("1. [high] src/app/page.tsx:12 — missing canonical link"), true)
    strictEqual(prompt.includes("   evidence: grep returned 0 matches"), true)
    strictEqual(prompt.includes("Fixer summary (claims — verify, do not trust):"), true)
    strictEqual(prompt.includes("1. fixed: added canonical link"), true)
    strictEqual(prompt.includes("Files changed by the fixer: src/app/page.tsx"), true)
    strictEqual(prompt.includes("Full report with additional context: /tmp/project/AUDIT-seo.md"), true)
  })
})

describe("clusterFindings", () => {
  const ten = ["f1 aaaaaaaaa", "f2 aaaaaaaaa", "f3 aaaaaaaaa", "f4 aaaaaaaaa", "f5 aaaaaaaaa", "f6 aaaaaaaaa", "f7 aaaaaaaaa", "f8 aaaaaaaaa", "f9 aaaaaaaaa", "f10 aaaaaaaa"]

  it("chunks 10 findings into [4,4,2] in order with maxClusters 3", () => {
    const clusters = clusterFindings(ten, 3)
    deepStrictEqual(clusters.map((c) => c.findings.length), [4, 4, 2])
    deepStrictEqual(
      clusters.flatMap((c) => c.findings),
      ten,
    )
    deepStrictEqual(clusters.map((c) => c.index), [1, 2, 3])
  })

  it("chunks 10 findings into [5,5] in order with maxClusters 2", () => {
    const clusters = clusterFindings(ten, 2)
    deepStrictEqual(clusters.map((c) => c.findings.length), [5, 5])
    strictEqual(clusters[0]?.findings[0], "f1 aaaaaaaaa")
    strictEqual(clusters[1]?.findings[0], "f6 aaaaaaaaa")
  })

  it("collapses maxClusters 0 or negative to a single cluster", () => {
    deepStrictEqual(clusterFindings(ten, 0).map((c) => c.findings.length), [10])
    deepStrictEqual(clusterFindings(ten, -3).map((c) => c.findings.length), [10])
    strictEqual(clusterFindings(ten, 0)[0]?.index, 1)
  })

  it("returns [] for empty input", () => {
    deepStrictEqual(clusterFindings([], 4), [])
  })

  it("never creates more clusters than findings", () => {
    const clusters = clusterFindings(["only one finding"], 8)
    deepStrictEqual(clusters.map((c) => c.findings.length), [1])
  })
})

describe("parseVerdicts", () => {
  const findings = ["[high] src/a.ts:1 — issue one", "[med] src/b.ts:2 — issue two", "[low] src/c.ts:3 — issue three"]

  it("parses colon-form verdicts case-insensitively", () => {
    const v = parseVerdicts("1. FIXED: gone\n2. NOT-FIXED: still there\n3. Bad-Fix: broke imports", findings)
    strictEqual(v[0]?.verdict, "fixed")
    strictEqual(v[1]?.verdict, "not-fixed")
    strictEqual(v[2]?.verdict, "bad-fix")
  })

  it("accepts needs-human and unknown verdicts", () => {
    const v = parseVerdicts("1. needs-human: design decision required\n2. unknown: could not verify", findings)
    strictEqual(v[0]?.verdict, "needs-human")
    strictEqual(v[1]?.verdict, "unknown")
  })

  it("falls back to unknown with empty note for unparseable lines", () => {
    const v = parseVerdicts("1. blah: nonsense", findings)
    strictEqual(v[0]?.verdict, "unknown")
    strictEqual(v[0]?.note, "")
  })
})

describe("clean-run marker skip", () => {
  it("parseFindings drops 'No findings.' lines", () => {
    deepStrictEqual(parseFindings("- No findings."), [])
  })

  it("extractFindings drops 'No findings.' lines", () => {
    deepStrictEqual(extractFindings("## probe (a)\n\n- No findings."), [])
  })
})
