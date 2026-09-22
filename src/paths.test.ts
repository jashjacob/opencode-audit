import { strictEqual, throws } from "node:assert/strict"
import { describe, it } from "node:test"
import { resolveWorktreePath } from "./paths.js"

describe("resolveWorktreePath", () => {
  it("keeps relative paths inside the worktree", () => {
    strictEqual(resolveWorktreePath("/tmp/project", "reports/audit.md"), "/tmp/project/reports/audit.md")
  })

  it("rejects parent traversal and absolute paths", () => {
    throws(() => resolveWorktreePath("/tmp/project", "../outside.md"), /inside the worktree/)
    throws(() => resolveWorktreePath("/tmp/project", "/tmp/outside.md"), /inside the worktree/)
  })
})
