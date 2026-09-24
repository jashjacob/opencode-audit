import { strictEqual, throws } from "node:assert/strict"
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { resolveWorktreePath } from "./paths.js"

describe("resolveWorktreePath", () => {
  it("keeps relative paths inside the worktree", () => {
    const worktree = mkdtempSync(join(tmpdir(), "opencode-audit-paths-"))
    try {
      strictEqual(resolveWorktreePath(worktree, "reports/audit.md"), join(realpathSync(worktree), "reports/audit.md"))
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it("rejects parent traversal and absolute paths", () => {
    const worktree = mkdtempSync(join(tmpdir(), "opencode-audit-paths-"))
    try {
      throws(() => resolveWorktreePath(worktree, "../outside.md"), /inside the worktree/)
      throws(() => resolveWorktreePath(worktree, "/tmp/outside.md"), /inside the worktree/)
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it("rejects dangling symlink ancestors before resolving a destination", () => {
    const worktree = mkdtempSync(join(tmpdir(), "opencode-audit-paths-"))
    try {
      symlinkSync(join(tmpdir(), `opencode-audit-missing-${process.pid}`), join(worktree, "dangling"), "dir")
      throws(() => resolveWorktreePath(worktree, "dangling/reports/audit.md"), /symlink/)
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  })
})
