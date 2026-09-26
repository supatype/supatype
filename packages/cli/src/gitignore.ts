import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

export const SUPATYPE_GITIGNORE_MARKER = "# Supatype, local runtime (contains secrets in link.json)"

/**
 * Every path Supatype writes that holds a secret, in one place.
 *
 * One list because there were two emitters, this one and `init`'s own template, and they had
 * already drifted apart on content. Two lists of the same thing drift again, and the half that
 * drifts is discovered by a key reaching a public repository.
 *
 * `.env.local` and `.env.*.local` are here because `.env` does not cover them. That pattern matches
 * a file named exactly `.env`, while `supatype functions new` writes `functions/.env.local` with
 * "These are NOT committed to git" at the top of it, and the worker reads
 * `.env.<function>.local` beside that. Verified with `git check-ignore`: under `.env` alone both
 * were tracked; with these two they are ignored at any depth, and no source file is caught.
 */
const SUPATYPE_IGNORED_PATHS = [
  ".env",
  ".env.local",
  ".env.*.local",
  ".supatype/",
  "supatype.local.config.ts",
  "supatype.local.config.js",
  "supatype.local.config.mjs",
] as const

/** The paths above, for a scaffold that composes its own `.gitignore` around them. */
export const SUPATYPE_GITIGNORE_PATHS: readonly string[] = SUPATYPE_IGNORED_PATHS

export const SUPATYPE_GITIGNORE_BLOCK = `${SUPATYPE_GITIGNORE_MARKER}
${SUPATYPE_IGNORED_PATHS.join("\n")}
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
    // `.env` is not repeated here: the block below already carries it, along with the
    // `.env.local` patterns it does not cover.
    writeFileSync(gitignorePath, `node_modules/\ndist/\n${SUPATYPE_GITIGNORE_BLOCK}`, "utf8")
  }

  if (!opts?.silent) {
    console.warn("Added .supatype/ to .gitignore (link.json contains secrets, never commit).")
  }
  return true
}

export function warnIfLinkNotGitignored(cwd: string): void {
  if (isSupatypeGitignored(cwd)) return
  console.warn(
    "\n⚠  Warning: .supatype/ is not in .gitignore, link.json contains tokens and must not be committed.",
  )
  console.warn("   Run with link --fix-gitignore to append the Supatype block.\n")
}
