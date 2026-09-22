import path from "node:path"

/** Resolve a user-supplied path while keeping it inside the current worktree. */
export function resolveWorktreePath(worktree: string, requested: string): string {
  const root = path.resolve(worktree)
  const resolved = path.resolve(root, requested)
  const relative = path.relative(root, resolved)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path must stay inside the worktree: ${requested}`)
  }
  return resolved
}
