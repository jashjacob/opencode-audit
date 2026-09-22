import type { Playbook } from "./playbooks.js"
import { probeSystem } from "./playbooks.js"

export const extraPlaybooks: Record<string, Playbook> = {
  perf: {
    id: "perf",
    description: "Bundle weight, font/image pipeline, render-blocking and caching heuristics.",
    probes: [
      {
        name: "bundle-weight",
        agent: "explore",
        get system() {
          return probeSystem()
        },
        prompt: (t) =>
          `In ${t}: audit asset weight. Inventory the largest assets on disk (css, js, images, fonts, video) using file sizes, including build output (dist/, build/, .next/, out/) if present. Flag: assets over ~200KB (js/css) or ~500KB (images/fonts), files that look unminified (readable whitespace/comments in .js/.css in build output), duplicate assets (same content in multiple locations), and source files copied into build output that are not referenced by the bundle. Report path, size, and why it is a problem. If no build output exists, audit source assets and say so explicitly.`,
      },
      {
        name: "font-images",
        agent: "explore",
        get system() {
          return probeSystem()
        },
        prompt: (t) =>
          `In ${t}: audit font loading and the image pipeline. Fonts: check for preload hints, font-display (swap/optional vs block), self-hosted vs third-party hosting, and whether font files are subsetted (compare file sizes; flag full multi-script families). Images: check for modern formats (avif/webp) usage, lazy loading below the fold, explicit width/height or aspect-ratio to prevent CLS, and responsive sizes (srcset/sizes or framework equivalents). Report each violation with file path, line, and why it hurts performance. If a category is clean, say so explicitly.`,
      },
      {
        name: "blocking",
        agent: "general",
        get system() {
          return probeSystem("Use websearch to confirm current Core Web Vitals thresholds and known third-party script costs where needed.")
        },
        prompt: (t) =>
          `In ${t}: audit render-blocking and caching patterns. Find: synchronous <script> tags in <head> without defer/async, blocking stylesheet chains, inline styles blocking first paint, third-party scripts (analytics, chat widgets, tag managers) loaded eagerly, and cache-header/config opportunities visible in code (static asset caching config, CDN/headers config, missing immutable hashing). Tie every finding to its Core Web Vitals impact (LCP/CLS/INP) with the mechanism stated. Report file, line/pattern, and CWV impact.`,
      },
    ],
  },

  content: {
    id: "content",
    description: "Metadata quality, trust/proof gaps, and factual freshness.",
    probes: [
      {
        name: "meta-quality",
        agent: "explore",
        get system() {
          return probeSystem()
        },
        prompt: (t) =>
          `In ${t}: audit title and meta description quality for every page/route. Flag: missing or empty <title>/meta description, duplicated titles or descriptions across pages, titles over 60 characters, descriptions over 155 characters, generic boilerplate titles (site name only, "Home", "Untitled"), and thin pages with almost no body content (a heading plus a single paragraph). Report file, route, current value with character count, and the specific problem. If a category is clean, say so explicitly.`,
      },
      {
        name: "proof-gaps",
        agent: "explore",
        get system() {
          return probeSystem()
        },
        prompt: (t) =>
          `In ${t}: audit trust and proof content relative to what the site sells. First determine the site's core offerings from its copy/products/services. Then check each money page (home, service, product, pricing) for: testimonials or reviews, certifications/awards/memberships, case studies or portfolio evidence, concrete specs/guarantees/warranties, and contact evidence (address, phone, team pages). Flag pages that ask for a conversion but lack the corresponding proof, with the page file and the missing proof type. If a category is clean, say so explicitly.`,
      },
      {
        name: "freshness",
        agent: "general",
        get system() {
          return probeSystem("Use websearch to verify dated claims (years, statistics, product versions, prices) against current facts where possible.")
        },
        prompt: (t) =>
          `In ${t}: audit factual and date staleness. Find: hardcoded copyright years that lag the current year, dated claims ("since 2019", "10+ years of experience") that may no longer hold, statistics/prices/version numbers embedded in copy that can go stale, and external references in copy (links, named tools, events) that are dead or outdated. Use websearch to check questionable facts against current reality. Report file, line, the stale claim, and why it is a problem. If a category is clean, say so explicitly.`,
      },
    ],
  },
}
