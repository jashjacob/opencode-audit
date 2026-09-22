/**
 * Audit Fleet Widget - Live Probe Status (sidebar_footer slot)
 *
 * Shows live status of the audit fleet's probe subagent sessions
 * (titled `audit:<probe-name>`) and fixer sessions (`fix:<playbook>:<n>`).
 * Polls every 2 seconds.
 *
 * Shows up to three lines:
 *   🛰 fleet
 *   ▪ dead-css running · tokens done · orphan-assets idle
 *   fix: dead-css:3 ✓ · tokens:1 ⟳
 *
 * The companion server plugin (see /tui/plugin in the opencode-audit project)
 * spawns probe subagents as child sessions of the current session with
 * `audit:<name>` titles. Discovery uses the SDK client; if it fails or finds
 * nothing, the widget degrades to scanning the CURRENT session's messages
 * for `# <name> audit` report headers:
 *   fleet: last audit dead-css · 2 audits
 *
 * Install:
 *   cp fleet-widget.tsx ~/.config/opencode/plugins/fleet-widget.tsx
 *   Add to ~/.config/opencode/tui.json:
 *     { "plugin": ["./plugins/fleet-widget.tsx"] }
 *   Open the sidebar (Ctrl+X B) to see the footer.
 */

/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"

type ProbeEntry = {
  kind: "probe"
  name: string
  sessionID: string
}

type FixEntry = {
  kind: "fix"
  playbook: string
  n: string
  sessionID: string
}

type FleetEntry = ProbeEntry | FixEntry

type StatusLabel = "running" | "done" | "idle"

type ScanPart = {
  type?: string
  text?: string
  state?: { status?: string; output?: string }
}

function FleetFooter(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current

  const [tick, setTick] = createSignal(0)
  const [discovered, setDiscovered] = createSignal<FleetEntry[] | null>(null)
  const [fallback, setFallback] = createSignal<{ last: string; count: number } | null>(null)

  const directory = (): string | undefined => {
    try {
      const dir = props.api.state?.path?.directory
      return typeof dir === "string" && dir.length > 0 ? dir : undefined
    } catch {
      return undefined
    }
  }

  const parseEntries = (sessions: { id?: string; title?: string }[]): FleetEntry[] => {
    const out: FleetEntry[] = []
    for (const s of sessions) {
      const id = s?.id
      const title = s?.title
      if (!id || typeof title !== "string") continue
      const audit = /^audit:([\w-]+)$/.exec(title)
      if (audit) {
        out.push({ kind: "probe", name: audit[1], sessionID: id })
        continue
      }
      const fix = /^fix:([\w-]+):(\d+)$/.exec(title)
      if (fix) {
        out.push({ kind: "fix", playbook: fix[1], n: fix[2], sessionID: id })
      }
    }
    return out
  }

  let inFlight = false
  const refresh = async () => {
    if (inFlight) return
    inFlight = true
    try {
      const client = props.api?.client
      if (!client) return
      let entries: FleetEntry[] | null = null
      try {
        const res = await client.session.children({
          sessionID: props.session_id,
          ...(directory() ? { directory: directory() } : {}),
        })
        if (res && !res.error && Array.isArray(res.data)) {
          entries = parseEntries(res.data as { id?: string; title?: string }[])
        }
      } catch {}
      if (!entries) {
        try {
          const dir = directory()
          const res = await client.session.list({ limit: 100, ...(dir ? { directory: dir } : {}) })
          if (res && !res.error && Array.isArray(res.data)) {
            entries = parseEntries(res.data as { id?: string; title?: string }[])
          }
        } catch {}
      }
      if (entries && entries.length > 0) {
        setDiscovered(entries)
        return
      }
      // No fleet sessions found — degrade to scanning the current session's
      // messages for "# <name> audit" report headers (also inside completed
      // tool results, where the audit report lands).
      try {
        const msgs = props.api.state?.session?.messages?.(props.session_id) || []
        const names: string[] = []
        let count = 0
        for (const m of msgs) {
          let parts: ScanPart[] = []
          try {
            parts = (props.api.state?.part?.(m.id) || []) as unknown as ScanPart[]
          } catch {
            continue
          }
          for (const p of parts) {
            const texts: string[] = []
            if (p?.type === "text" && typeof p.text === "string") texts.push(p.text)
            if (p?.type === "tool" && p.state?.status === "completed" && typeof p.state?.output === "string") {
              texts.push(p.state.output)
            }
            for (const text of texts) {
              for (const match of text.matchAll(/#\s*([\w-]+)\s+audit\b/g)) {
                const name = match[1]
                if (name && !names.includes(name)) names.push(name)
                count++
              }
            }
          }
        }
        setFallback({ last: names.length > 0 ? names[names.length - 1] : "", count })
        setDiscovered(null)
      } catch {
        setFallback(null)
        setDiscovered(null)
      }
    } finally {
      inFlight = false
    }
  }

  const findings = (sessionID: string): number => {
    try {
      const msgs = props.api.state?.session?.messages?.(sessionID) || []
      let chars = 0
      for (const m of msgs) {
        let parts: { type?: string; text?: string }[] = []
        try {
          parts = (props.api.state?.part?.(m.id) || []) as unknown as { type?: string; text?: string }[]
        } catch {
          continue
        }
        for (const p of parts) {
          if (p?.type === "text" && typeof p.text === "string") chars += p.text.length
        }
      }
      return chars
    } catch {
      return 0
    }
  }

  const statusOf = (sessionID: string): StatusLabel => {
    try {
      const status = props.api.state?.session?.status?.(sessionID)
      if (status?.type === "busy" || status?.type === "retry") return "running"
      if (status?.type === "idle") {
        return findings(sessionID) > 0 ? "done" : "idle"
      }
    } catch {}
    return "idle"
  }

  const statusColor = (status: StatusLabel) => {
    const t = theme()
    if (status === "running") return t?.accent
    if (status === "done") return t?.success
    return t?.textMuted
  }

  const view = createMemo(() => {
    tick()

    const entries = discovered()
    if (!entries || entries.length === 0) {
      return { mode: "fallback" as const, probes: [] as { label: string; status: StatusLabel }[], fixes: [] as string[] }
    }

    const probes: { label: string; status: StatusLabel }[] = []
    const fixes: string[] = []
    for (const e of entries) {
      if (e.kind === "probe") {
        probes.push({ label: e.name, status: statusOf(e.sessionID) })
      } else {
        const status = statusOf(e.sessionID)
        const mark = status === "running" ? " ⟳" : status === "done" ? " ✓" : ""
        fixes.push(`${e.playbook}:${e.n}${mark}`)
      }
    }
    return { mode: "fleet" as const, probes, fixes }
  })

  const timer = setInterval(() => {
    setTick(t => t + 1)
    void refresh()
  }, 2000)
  onCleanup(() => clearInterval(timer))
  void refresh()

  return (
    <box>
      <text>
        <span style={{ fg: theme().textMuted }}>🛰 fleet</span>
      </text>
      <Show
        when={view().mode === "fleet"}
        fallback={
          <text>
            <span style={{ fg: theme().textMuted }}>fleet: </span>
            <Show
              when={fallback()?.last}
              fallback={<span style={{ fg: theme().textMuted }}>no audit activity</span>}
            >
              <span style={{ fg: theme().text }}>last audit {fallback()?.last}</span>
              <span style={{ fg: theme().textMuted }}> · </span>
              <span style={{ fg: theme().text }}>{fallback()?.count} audits</span>
            </Show>
          </text>
        }
      >
        <Show when={view().probes.length > 0}>
          <text>
            <For each={view().probes}>
              {(p, i) => (
                <>
                  <span style={{ fg: theme().textMuted }}>{i() === 0 ? "▪ " : " · "}</span>
                  <span style={{ fg: theme().text }}>{p.label}</span>
                  <span style={{ fg: statusColor(p.status) }}> {p.status}</span>
                </>
              )}
            </For>
          </text>
        </Show>
        <Show when={view().fixes.length > 0}>
          <text>
            <span style={{ fg: theme().textMuted }}>fix: {view().fixes.join(" · ")}</span>
          </text>
        </Show>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    slots: {
      sidebar_footer(_ctx, props: { session_id: string }) {
        return <FleetFooter api={api} session_id={props.session_id} />
      },
    },
  })
}

export default { id: "audit-fleet", tui } satisfies TuiPluginModule
