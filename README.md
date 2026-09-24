# opencode-audit

A plugin for [opencode](https://opencode.ai) that audits codebases and fixes the findings using fleets of parallel subagents.

```
/audit css    run read-only probes, write AUDIT-css.md
/fix css      fix that report's findings, each one independently verified
```

## Why

Auditing a codebase in one chat is slow and shallow. One agent works through everything sequentially, in a single context window, and can't edit while it inspects.

This plugin splits the job:

- **Audits** spawn N *read-only* probes concurrently. Each probe gets one narrow mandate (e.g. "unused selectors"), a system prompt that forbids edits, and a strict output format. False positives are treated as worse than misses — probes may only report what they verified against the actual code.
- **Fixes** spawn N edit-capable agents on clusters of findings, after a single permission prompt. Every cluster is then re-checked by a separate read-only validator that is explicitly told not to trust the fixer's summary.

Audits never touch your files. Fixes ask once, up front, before spawning anything that can edit.

## How an audit runs

1. `/audit <playbook>` resolves the playbook and loads the previous **snapshot** for that playbook + target from `~/.local/share/opencode/audit/<project>/<playbook>.json`.
2. The playbook expands into its probes. Each probe becomes a child session titled `audit:<probe-name>`, running as an `explore` agent (code inspection) or `general` agent (when web research is needed). Probes run in parallel, capped at `OPENCODE_AUDIT_CONCURRENCY` (default 5).
3. Each probe answers in a fixed output contract — one line per finding, an optional indented `evidence:` sub-bullet, caveats on `Note:` lines:

   ```
   - [high] src/app/page.tsx:12 — missing canonical link
     - evidence: grep 'rel="canonical"' src/app/page.tsx → 0 matches
   - [med] route:/checkout — sitemap entry missing
   > Note: could not verify pagination
   ```

4. The plugin collates every probe's reply into one markdown report: header (target, timestamp, severity counts, probe status), then one section per probe with findings nested above their evidence and notes rendered as blockquotes.
5. The report is diffed against the snapshot and a delta footer is appended:

   ```
   > 🆕 3 new · 5 resolved · 12 total findings since last run (2026-09-17T07:30:00Z)
   ```

6. The report is written to `AUDIT-<playbook>.md` in the worktree, the snapshot is updated only when every probe succeeds, and the report is returned to the conversation. An explicit report path must remain inside the worktree.

Delta identity is `location + issue` only. A finding that moved lines, changed severity, or got better evidence is recognized as the same issue — re-runs report only genuinely new findings.

## How a fix runs

1. `fix_fleet` reads `AUDIT-<playbook>.md` (or an explicit `report` path) and parses it: dedupe by stable identity, sort most-severe first, cap at 40, attach each finding's evidence (up to 3 lines).
2. Findings are chunked into clusters of ~4 in report order. With `dry_run: true` you get the plan — clusters, evidence, fixer instructions — and nothing else happens.
3. Otherwise the tool asks permission **once**, then runs non-overlapping clusters in parallel (default 4 concurrent). Clusters with overlapping locations are serialized so fixers never race over the same files. Fixer rules: verify each finding against the code before editing; minimal diffs; no drive-by refactors; mark wrong or already-fixed findings `invalid` instead of forcing a change; defer design decisions to `needs-human`; run the project's typecheck/lint/build scripts if they exist.
4. A read-only validator then re-checks every finding independently and returns one verdict per finding:

   | Verdict | Meaning |
   | --- | --- |
   | `fixed` | problem gone, change complete |
   | `not-fixed` | still present or only partially addressed |
   | `bad-fix` | the change introduced a new problem |
   | `needs-human` | legitimate deferral (design decision, scope) |
   | `unknown` | could not verify |

5. The tool returns clusters, files changed (with +/− stats when available), and the merged verdict table.
6. With `revalidate: true` it re-runs the audit probes, appends a `## Re-audit` section with a fresh delta, and refreshes the baseline. If any probe fails, the re-audit is skipped and the previous baseline is kept.

The two steps never chain automatically. `/audit` produces a report and a suggested todo list; nothing is fixed until you run `/fix`.

Before approving a fix run, review its `dry_run` plan and start from a clean Git state. Approval allows the fixer agents to edit files immediately; there is no built-in rollback. Review the resulting diff and use your normal Git workflow to keep or revert changes.

## Playbooks

| Playbook | Aliases | Probes |
| --- | --- | --- |
| `css` | `dead-css` | unused selectors · dead design tokens · orphaned style assets |
| `dependencies` | `deps`, `packages` | unused dependencies · dead scripts · dead code/exports |
| `seo` | | routes/canonical · structured data + robots · on-page metadata |
| `accessibility` | `access`, `a11y` | landmarks/ARIA · keyboard & focus · color contrast |
| `mobile` | `mobile-ux` | overflow/clipping · touch targets · viewport |
| `perf` | | bundle weight · font/image pipeline · render-blocking |
| `content` | | meta quality · proof gaps · freshness |

Natural language works too: *"audit unused CSS"*, *"fix the dead css findings"*.

## Finding format

```
- [high] src/app/page.tsx:12 — missing canonical link
  - evidence: grep 'rel="canonical"' src/app/page.tsx → 0 matches
- [med] route:/checkout — sitemap entry missing
> Note: could not verify pagination
```

- **Severity** — `high` breaks users, builds, or revenue; `med` is measurable quality/SEO/performance damage; `low` is hygiene.
- **Location** — `path:line` when a single line applies, a bare path otherwise, or `route:<slug>` / `url:<path>` for route-level findings. This is the stable key delta tracking uses.
- **Evidence** — the probe's proof: a grep result, computed contrast ratio, measured hit area, byte size. It flows into the fixer and validator prompts so agents work from the probe's findings instead of re-deriving them, while still having to verify before editing.
- **Notes** — caveats that aren't findings. Rendered as blockquotes, excluded from parsing, deltas, and fix clusters.

Evidence and notes never participate in delta identity, so editing proof can't create a phantom new finding.

## Snapshots and deltas

Snapshots live outside the repo (`~/.local/share/opencode/audit/<slug>-<hash>/<playbook>.json`), keyed by absolute project path. First run reports `first run — no baseline yet`; missing or corrupt snapshots are treated the same way. Reports and snapshots contain repository-derived findings and evidence. The plugin redacts common credential formats, but this is not comprehensive secret detection; review reports before sharing or committing them. Snapshots store the target path, timestamp, and finding text.

## Install

The plugin can be installed as one self-contained bundled file. By default, the bundle command writes to OpenCode's user plugin directory (`~/.config/opencode/plugins`):

```sh
git clone https://github.com/jashjacob/opencode-audit.git
cd opencode-audit
npm install
npm run bundle
```

Restart OpenCode. You get the `audit_fleet` and `fix_fleet` tools plus the `/audit` and `/fix` commands. To use another plugin directory, set `OPENCODE_PLUGIN_DIR`; to choose the complete output filename, set `OPENCODE_AUDIT_BUNDLE_OUT`:

```sh
OPENCODE_PLUGIN_DIR="/path/to/opencode/plugins" npm run bundle
OPENCODE_AUDIT_BUNDLE_OUT="/path/to/plugins/opencode-audit.js" npm run bundle
```

After the package is published, OpenCode can install it and its dependencies through the plugin list in `opencode.json`:

```json
{
  "plugin": ["opencode-audit"]
}
```

The npm package includes the compiled `dist/` entry point and declares the OpenCode plugin API as a runtime dependency. When installing directly from Git as a Node.js dependency, npm runs `prepare` to build the entry point.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENCODE_AUDIT_MODEL` | current session's model | Model for probe/fixer/validator subagents, e.g. `opencode-go/deepseek-v4.1-flash` |
| `OPENCODE_AUDIT_CONCURRENCY` | `5` | Max probes running at once |
| `OPENCODE_AUDIT_WRITE_REPORT` | `1` | Set `0` to skip writing `AUDIT-<playbook>.md` (an explicit `report` argument still wins) |
| `OPENCODE_AUDIT_DEBUG` | `0` | Log plugin activity to stderr |

## Privacy

The plugin does not make its own model-provider requests. It starts OpenCode sessions, which send prompts and relevant repository context to the model provider configured in OpenCode. Audit reports can contain paths, code excerpts, and other repository-derived evidence; fix prompts include findings and evidence. Common credential formats are redacted, but detection is not comprehensive. Review reports before sharing them, and do not commit them if they contain sensitive details. Local snapshots retain finding text and a redacted target string under `~/.local/share/opencode/audit/`; the raw target still determines the snapshot key.

## Troubleshooting

- If OpenCode does not show the tools or commands, confirm that `opencode-audit.js` is in the plugin directory OpenCode loads, then restart OpenCode.
- If bundling fails, run `npm install` in the cloned repository and check that Node.js 22 or newer is active.
- If an audit cannot resolve a model, configure `OPENCODE_AUDIT_MODEL` or start the command in a session with a selected model.
- If reports are not written, check `OPENCODE_AUDIT_WRITE_REPORT`; its default is `1`, and an explicit `report` argument requests a file regardless of that setting.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # compile tests + run them with node --test
npm run build       # tsc → dist/
npm run bundle      # bundle → OpenCode plugin directory (override with env vars above)
```

Publishing a GitHub release triggers the npm workflow. Configure an `NPM_TOKEN` repository secret with permission to publish this package before creating a release.

Layout:

```
src/
  index.ts          plugin entry: audit_fleet tool, commands, hooks
  playbooks.ts      playbook + probe definitions, OUTPUT_CONTRACT
  playbooks-extra.ts  perf + content playbooks
  orchestrator.ts   spawns probe sessions with bounded concurrency
  report.ts         collates probe text into the markdown report
  state.ts          snapshot I/O, finding parsing, delta diffing
  fix-fleet.ts      fix_fleet: parse, cluster, fix, validate
  config.ts         env-var config, session model tracking
```

### Adding a playbook

Add a key in `src/playbooks.ts` or `src/playbooks-extra.ts`. Each probe is a name, an agent (`explore` or `general`), a probe-only system prompt, and a prompt builder that receives the target path. The output contract is appended automatically. Then `npm run bundle` and restart.

## License

[MIT](LICENSE)
