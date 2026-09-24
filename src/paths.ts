import fs from "node:fs"
import path from "node:path"

/** Resolve a user-supplied path while keeping it inside the current worktree. */
export function resolveWorktreePath(worktree: string, requested: string): string {
  const root = fs.realpathSync(worktree)
  const resolved = path.resolve(root, requested)
  const lexicalRelative = path.relative(root, resolved)
  if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
    throw new Error(`Path must stay inside the worktree: ${requested}`)
  }

  // realpath cannot resolve a dangling symlink target. Inspect every existing
  // component first so a link to a missing outside path cannot be treated as a
  // harmless nonexistent destination and later followed by mkdir/write.
  let componentPath = root
  for (const component of lexicalRelative.split(path.sep).filter(Boolean)) {
    componentPath = path.join(componentPath, component)
    try {
      if (fs.lstatSync(componentPath).isSymbolicLink()) {
        throw new Error(`Path must not traverse a symlink: ${requested}`)
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTDIR") break
      throw error
    }
  }

  let existing = resolved
  const missing: string[] = []
  while (true) {
    try {
      existing = fs.realpathSync(existing)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") {
        throw error
      }
      const parent = path.dirname(existing)
      if (parent === existing) throw error
      missing.unshift(path.basename(existing))
      existing = parent
    }
  }
  const canonical = path.resolve(existing, ...missing)
  const relative = path.relative(root, canonical)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path must stay inside the worktree: ${requested}`)
  }
  return resolved
}
