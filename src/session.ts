/** Extract the assistant's text from the SDK's session.prompt response. */
export const READ_ONLY_TOOLS: Record<string, boolean> = {
  "*": false,
  read: true,
  grep: true,
  glob: true,
  list: true,
  lsp: true,
  websearch: true,
  webfetch: true,
  bash: false,
  edit: false,
  write: false,
  patch: false,
  apply_patch: false,
  task: false,
  todowrite: false,
  todoread: false,
  skill: false,
  question: false,
}

export function extractSessionText(reply: unknown): string {
  const response = reply as {
    parts?: Array<{ type?: string; text?: string }>
    data?: { parts?: Array<{ type?: string; text?: string }> }
  }
  const parts = response?.parts ?? response?.data?.parts ?? []
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim()
}

export function isAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("operation aborted")
}

/** Abort an in-flight OpenCode session when the enclosing tool is cancelled. */
export async function promptWithAbort<T>(
  client: {
    session: {
      abort: (opts: { path: { id: string }; query: { directory: string } }) => Promise<unknown>
    }
  },
  sessionID: string,
  directory: string,
  signal: AbortSignal,
  prompt: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) {
    await client.session.abort({ path: { id: sessionID }, query: { directory } }).catch(() => {})
    throw isAbortError(signal)
  }
  let abortSession: Promise<unknown> | undefined
  const onAbort = () => {
    abortSession = client.session.abort({ path: { id: sessionID }, query: { directory } })
  }
  let rejectOnAbort: (error: Error) => void = () => {}
  const onAbortReject = () => rejectOnAbort(isAbortError(signal))
  signal.addEventListener("abort", onAbort, { once: true })
  signal.addEventListener("abort", onAbortReject, { once: true })
  try {
    const result = await Promise.race([
      prompt(),
      new Promise<never>((_, reject) => {
        rejectOnAbort = reject
        if (signal.aborted) reject(isAbortError(signal))
      }),
    ])
    return result
  } finally {
    signal.removeEventListener("abort", onAbort)
    signal.removeEventListener("abort", onAbortReject)
    if (abortSession) await abortSession.catch(() => {})
  }
}
