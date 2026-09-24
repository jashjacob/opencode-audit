export type AuditConfig = {
  debug: boolean
  model: { providerID: string; modelID: string } | null
  maxConcurrency: number
  writeReport: boolean
}

export type ModelRef = { providerID: string; modelID: string }

const sessionModels = new Map<string, ModelRef>()

export function recordSessionModel(sessionID: string, model?: ModelRef): void {
  if (!sessionID || !model?.providerID || !model?.modelID) return
  sessionModels.set(sessionID, { providerID: model.providerID, modelID: model.modelID })
  if (sessionModels.size > 500) {
    const oldest = sessionModels.keys().next().value
    if (oldest) sessionModels.delete(oldest)
  }
}

export function getRecordedModel(sessionID: string): ModelRef | null {
  return sessionModels.get(sessionID) ?? null
}

type SessionMessageLike = {
  info?: { model?: ModelRef }
  model?: ModelRef
}

export async function resolveSessionModel(
  client: { session: { messages: (opts: { path: { id: string } }) => Promise<unknown> } },
  sessionID: string,
): Promise<ModelRef | null> {
  const recorded = getRecordedModel(sessionID)
  if (recorded) return recorded
  try {
    const resp = (await client.session.messages({ path: { id: sessionID } })) as {
      data?: SessionMessageLike[]
    }
    const list = Array.isArray(resp?.data) ? resp.data : (resp as unknown as SessionMessageLike[]) ?? []
    for (const m of [...list].reverse()) {
      const model = m?.info?.model ?? (m as SessionMessageLike)?.model
      if (model?.providerID && model?.modelID) {
        recordSessionModel(sessionID, model)
        return { providerID: model.providerID, modelID: model.modelID }
      }
    }
  } catch {}
  return null
}

export function requireModel(sessionID: string, resolved: ModelRef | null): ModelRef {
  if (resolved) return resolved
  throw new Error(
    `Could not determine the model for session ${sessionID}. Set OPENCODE_AUDIT_MODEL=<provider>/<model> (e.g. opencode-go/deepseek-v4.1-flash) and retry.`,
  )
}

export function loadConfig(): AuditConfig {
  const env = process.env
  const debug = env.OPENCODE_AUDIT_DEBUG === "1" || env.OPENCODE_AUDIT_DEBUG === "true"
  const model = env.OPENCODE_AUDIT_MODEL
  const requestedConcurrency = Number(env.OPENCODE_AUDIT_CONCURRENCY)
  return {
    debug,
    model: model
      ? (() => {
          const [providerID, ...rest] = model.split("/")
          if (!providerID) return null
          return { providerID, modelID: rest.join("/") }
        })()
      : null,
    maxConcurrency: Math.min(8, Math.max(1, Number.isFinite(requestedConcurrency) ? Math.floor(requestedConcurrency) || 5 : 5)),
    writeReport: env.OPENCODE_AUDIT_WRITE_REPORT !== "0",
  }
}

export function createLogger(debug: boolean) {
  const log = (level: string, msg: string) => {
    if (level !== "error" && !debug) return
    console.error(`[opencode-audit] ${new Date().toISOString()} ${level.toUpperCase()}: ${msg}`)
  }
  return {
    debug: (msg: string) => log("debug", msg),
    info: (msg: string) => log("info", msg),
    error: (msg: string) => log("error", msg),
  }
}
