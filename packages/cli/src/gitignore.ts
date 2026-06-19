import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

export const SUPATYPE_GITIGNORE_MARKER = "# Supatype — local runtime (contains secrets in link.json)"
export const SUPATYPE_GITIGNORE_BLOCK = `${SUPATYPE_GITIGNORE_MARKER}
.env
.supatype/
supatype.local.config.ts
supatype.local.config.js
supatype.local.config.mjs
`

export function isSupatypeGitignored(cwd: string): boolean {
  const gitignorePath = resolve(cwd, ".gitignore")
  if (!existsSync(gitignorePath)) return false
  const content = readFileSync(gitignorePath, "utf8")
  return /\.supatype\/?(\/|\s|$)/m.test(content) || content.includes(".supatype/")
}

export function ensureSupatypeGitignore(cwd: string, opts?: { silent?: boolean }): boolean {
  const gitignorePath = resolve(cwd, ".gitignore")
  if (isSupatypeGitignored(cwd)) return true

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf8")
    const next = content.endsWith("\n") ? content : `${content}\n`
    writeFileSync(gitignorePath, `${next}\n${SUPATYPE_GITIGNORE_BLOCK}`, "utf8")
  } else {
    writeFileSync(
      gitignorePath,
      `.env\nnode_modules/\ndist/\n${SUPATYPE_GITIGNORE_BLOCK}`,
      "utf8",
    )
  }

  if (!opts?.silent) {
    console.warn("Added .supatype/ to .gitignore (link.json contains secrets — never commit).")
  }
  return true
}

export function warnIfLinkNotGitignored(cwd: string): void {
  if (isSupatypeGitignored(cwd)) return
  console.warn(
    "\n⚠  Warning: .supatype/ is not in .gitignore — link.json contains tokens and must not be committed.",
  )
  console.warn("   Run with link --fix-gitignore to append the Supatype block.\n")
}
