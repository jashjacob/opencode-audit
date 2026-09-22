export type ProbeAgent = "explore" | "general"

export type Probe = {
  name: string
  agent: ProbeAgent
  system: string
  prompt: (target: string) => string
}

export type Playbook = {
  id: string
  description: string
  probes: Probe[]
}

export const PROBE_ONLY = [
  "You are a read-only probe agent. DO NOT write, edit, delete, or create any files.",
  "Use grep/glob/read (and websearch/webfetch only when the probe prompt says to) to gather evidence.",
  "Only report a finding if you verified it against the actual code: you read the exact file and location, or ran the exact check. A false positive costs more than a missed finding — omit anything you could not confirm.",
  "Never report the same issue twice.",
  "Your final reply must follow the OUTPUT CONTRACT at the end of the user message exactly; do not invent a different format.",
  "If a category is clean, reply with exactly the line 'No findings.' plus at most one short note line beginning 'Note:'.",
].join(" ")

export function probeSystem(extra?: string): string {
  return [PROBE_ONLY, extra].filter(Boolean).join(" ")
}

export const OUTPUT_CONTRACT = [
  "OUTPUT CONTRACT: every finding is exactly one bullet line in this form: '- [severity] <location> — <issue>'.",
  "Severity anchors: [high] breaks users, builds, or revenue (dead import that breaks a build, broken checkout flow, missing canonical on a money page, page unstyled at mobile widths).",
  "[med] measurable quality, SEO, or performance damage (duplicate titles or descriptions, touch targets under 44px, render-blocking script on the LCP path).",
  "[low] hygiene (unused local styles, dead internal exports, minor title length).",
  "Location token, placed immediately after the severity tag: file path:line (e.g. src/app/page.tsx:42) when a single line applies, the bare file path when no single line applies, or route:<slug> / url:<path> for route-level or site-level findings (no space after the colon).",
  "Findings only: never report items that pass; put any caveat on a separate line starting with 'Note:'.",
  "Optional proof: one indented sub-bullet directly under a finding with the form '- evidence: <the confirming check — grep result, computed value, measured width>'; omit it if the check is unverifiable.",
  "At most 20 findings, most impactful first, no duplicates.",
  "First-party code only: never report anything under node_modules, dist, build, out, or vendor directories.",
  "This contract overrides any earlier 'Report ...' wording in this prompt.",
].join(" ")

function applyOutputContract(playbooks: Record<string, Playbook>): void {
  for (const playbook of Object.values(playbooks)) {
    playbook.probes = playbook.probes.map((probe) => ({
      ...probe,
      prompt: (target: string) => `${probe.prompt(target)}\n\n${OUTPUT_CONTRACT}`,
    }))
  }
}

import { extraPlaybooks } from "./playbooks-extra.js"

const playbooks: Record<string, Playbook> = {
  css: {
    id: "css",
    description: "Unused CSS selectors, dead design tokens, orphaned style assets.",
    probes: [
      {
        name: "selectors",
        agent: "explore",
        system: probeSystem(),
        prompt: (t) =>
          `In ${t}: audit unused CSS selectors. Cross-reference every class, id, and attribute selector defined in *.css / *.scss against every source and template file (html, tsx, jsx, js, ts, php). Report: selector, defining file, line, and the evidence that nothing references it.`,
      },
      {
        name: "tokens",
        agent: "explore",
        system: probeSystem(),
        prompt: (t) =>
          `In ${t}: audit design tokens. Find CSS custom properties (--*) and/or theme tokens that are declared but never consumed anywhere. Report: token name, declaration location, and confirm zero usages.`,
      },
      {
        name: "orphan-assets",
        agent: "general",
        system: probeSystem(),
        prompt: (t) =>
          `In ${t}: find style assets on disk with zero references: unused .css/.scss files, unused icon/font files, and imports that resolve to nothing. Use glob to enumerate candidates, then grep for references. Report absolute paths and the confirming grep result.`,
      },
    ],
  },

  dependencies: {
    id: "dependencies",
    description: "Dead dependencies, unused scripts, dead exports and files.",
    probes: [
      {
        name: "deps",
        agent: "explore",
        system: probeSystem(),
        prompt: (t) =>
          `In ${t}: audit package.json (and pnpm-lock/yarn.lock/bun.lockb if present). For each dependency and devDependency, grep the source for its bare import/require/usage. Report each package that is declared but never imported, with the import search evidence. Note which runtime/script uses it if any.`,
      },
      {
        name: "scripts",
        agent: "explore",
        system: probeSystem(),
        prompt: (t) =>
          `In ${t}: audit package.json scripts and any Makefile/taskfile/CI yaml. Identify scripts that reference files or commands that no longer exist, and build/CI steps that are dead (never invoked, or fail immediately). Report script name, location, and reason.`,
      },
      {
        name: "dead-code",
        agent: "general",
        system: probeSystem(),
        prompt: (t) =>
          `In ${t}: audit for dead code: exported functions/components/helpers that are never imported anywhere, unused exports, and orphaned route files. Use grep to find each export and its references. Report symbol, file, line, and confirming grep result.`,
      },
    ],
  },

  seo: {
    id: "seo",
    description: "Sitemap/canonical, structured data, robots and on-page metadata.",
    probes: [
      {
        name: "routes",
        agent: "explore",
        system: probeSystem(),
        prompt: (t) =>
          `In ${t}: audit routing and canonical structure. Find the route definitions and sitemap source. Verify: every public route appears in the sitemap, canonical URLs match the route, no duplicate/missing trailing-slash variants, and pagination is correctly linked (prev/next). Report each route with status (ok / missing / mismatch).`,
      },
      {
        name: "structured-data",
        agent: "general",
        system: probeSystem("Use websearch to verify current schema.org and Google requirements."),
        prompt: (t) =>
          `In ${t}: audit structured data (JSON-LD) and robots.txt. For each page type (home, listing, product, article, legal), check: valid JSON-LD present, correct @type, required properties populated, and robots.txt allowing crawl of public pages while blocking the right private ones. Report page type, file, and any schema violations.`,
      },
      {
        name: "on-page",
        agent: "explore",
        system: probeSystem(),
        prompt: (t) =>
          `In ${t}: audit on-page metadata. For every page template, check presence and correctness of: <title>, meta description, canonical, og:*, twitter:*, and hreflang where applicable. Flag missing, empty, duplicated, or over-length values. Report template file and the tag status.`,
        },
    ],
  },

  accessibility: {
    id: "accessibility",
    description: "Landmarks/ARIA, keyboard and focus, color contrast.",
    probes: [
      {
        name: "landmarks",
        agent: "explore",
        system: probeSystem(),
        prompt: (t) =>
          `In ${t}: audit semantic structure. Check every template for: a single <h1>, correct heading order (no skipped levels), use of <main>/<nav>/<header>/<footer>/<aside> landmarks, and correct/valid ARIA attributes (aria-label, aria-hidden, role) with no redundant or conflicting roles. Report file and issue per finding.`,
      },
      {
        name: "keyboard",
        agent: "general",
        system: probeSystem(),
        prompt: (t) =>
          `In ${t}: audit keyboard and focus behavior. Find custom buttons, dropdowns, modals, carousels, and toggles. Verify each is reachable via Tab, activatable with Enter/Space, closes with Escape, and traps focus correctly where required. Flag elements relying only on click/onClick without keyboard handlers or native semantics. Report file, component, and the gap.`,
      },
      {
        name: "contrast",
        agent: "explore",
        system: probeSystem(),
        prompt: (t) =>
          `In ${t}: audit color contrast. From the design tokens and component styles, compute contrast ratios for text vs background across light and dark themes. Flag pairs below WCAG AA (4.5:1 body, 3:1 large text/UI). Report the two colors, ratio, and where they are used.`,
      },
    ],
  },

  mobile: {
    id: "mobile",
    description: "Overflow/clipping, touch targets, viewport and small-screen behavior.",
    probes: [
      {
        name: "overflow",
        agent: "explore",
        system: probeSystem(),
        prompt: (t) =>
          `In ${t}: audit for horizontal overflow and clipping at mobile widths (320-480px). Look for fixed widths, tables, long unbroken strings, absolute positioning, and grid/flex layouts without responsive fallbacks. Report file, selector, and the width at which it breaks.`,
      },
      {
        name: "touch",
        agent: "general",
        system: probeSystem(),
        prompt: (t) =>
          `In ${t}: audit touch targets and interaction patterns. Find all interactive elements (links, buttons, inputs, swipers, taskbars). Flag any with effective hit area under 44x44px, elements too close to each other (no spacing), and hover-only affordances that fail on touch. Report file, element, and the violation.`,
      },
      {
        name: "viewport",
        agent: "explore",
        system: probeSystem(),
        prompt: (t) =>
          `In ${t}: audit responsive/mobile setup. Check: viewport meta tag present and correct, media query breakpoints cover 320-768px, images/video have proper sizing (no fixed desktop widths), no body-level fixed min-width, and safe-area insets for notched devices. Report file and issue.`,
      },
    ],
  },
}

Object.assign(playbooks, extraPlaybooks)

applyOutputContract(playbooks)

export const PLAYBOOK_ALIASES: Record<string, string> = {
  "dead-css": "css",
  "unused-deps": "dependencies",
  deps: "dependencies",
  packages: "dependencies",
  "mobile-ux": "mobile",
  a11y: "accessibility",
  access: "accessibility",
}

export function resolvePlaybook(id: string): Playbook {
  const canonical = PLAYBOOK_ALIASES[id] ?? id
  const playbook = playbooks[canonical]
  if (!playbook) {
    throw new Error(
      `Unknown audit playbook "${id}". Available: ${Object.keys(playbooks).join(", ")}`,
    )
  }
  return playbook
}

export function listPlaybooks(): string[] {
  return Object.keys(playbooks)
}