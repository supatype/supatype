import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import ignore, { type Ignore } from "ignore"

export const SUPATYPE_GITIGNORE_MARKER = "# Supatype: secrets (.env, .supatype/link.json) and local or generated files"

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
  // Generated from schema/index.ts by `supatype generate`, which needs no database and no
  // running stack, so a clone can always rebuild it. Listed here rather than only in the
  // `init` template so projects that already exist pick it up too.
  //
  // The default path. A project that moves `output.client` moves this with it, and would
  // need its own line: there is no pattern that follows a value from the config file.
  "supatype/generated/seed.ts",
] as const

/** The paths above, for a scaffold that composes its own `.gitignore` around them. */
export const SUPATYPE_GITIGNORE_PATHS: readonly string[] = SUPATYPE_IGNORED_PATHS

export const SUPATYPE_GITIGNORE_BLOCK = `${SUPATYPE_GITIGNORE_MARKER}
${SUPATYPE_IGNORED_PATHS.join("\n")}
`

/**
 * Whether the rules of a `.gitignore` already ignore everything the single entry `entry` would: the
 * paths it names at the top of the repository and, for an entry with no `/` before its end (which
 * git matches at any depth), in a folder below it too. A wildcard stands for a name no rule mentions.
 *
 * 0.9.2 release test (N-RB1): init merged by looking for exact lines, so it left `.env` out and added
 * `.env.*.local` under create-expo-app's `.env*.local`, which covers it. The rules are matched by
 * `ignore`, which follows gitignore(5) as git does (negation, directory-only patterns, anchoring,
 * character classes, an ignored parent folder ignoring what is in it); a hand-written matcher here
 * got bracket classes wrong.
 */
function coversEntry(rules: Ignore, entry: string): boolean {
  const path = probePath(entry)
  const anyDepth = !path.replace(/\/$/, "").includes("/")
  return rules.ignores(path) && (!anyDepth || rules.ignores(`supatype-nested/${path}`))
}

/** The path `ignore` is asked about for `entry`: a wildcard stands for a name no rule mentions. */
function probePath(entry: string): string {
  return entry.replace(/\*/g, "supatype-any")
}

/** Each of {@link SUPATYPE_GITIGNORE_PATHS} that a `.gitignore` holding `content` does not ignore yet. */
export function missingSupatypeIgnores(content: string): string[] {
  const rules = ignore().add(content)
  return SUPATYPE_IGNORED_PATHS.filter((entry) => !coversEntry(rules, entry))
}

/**
 * The line to print when some of `missing` are un-ignored by a `!` line in the `.gitignore` holding
 * `content`; undefined when none are. Adding them overrides a choice the developer made, which keeps
 * the secrets out of git but must not happen silently.
 *
 * 0.9.2 release test round 2 (R2-S6): init appended `.env` after a user's `!.env` and printed only
 * "updated .gitignore (added Supatype's local files)".
 */
export function negationOverrideNotice(content: string, missing: readonly string[]): string | undefined {
  const rules = ignore().add(content)
  const negated = missing.filter((entry) => rules.test(probePath(entry)).unignored).join(", ")
  if (negated === "") return undefined
  return `Your .gitignore un-ignores ${negated} with a "!" line; added it again below so secrets stay out of git (remove it from the Supatype block to commit anyway).`
}

/**
 * `content` with every one of Supatype's paths it does not already ignore added at the end, under
 * the marker; unchanged when it ignores them all. The one way init and `link --fix-gitignore` add to
 * a `.gitignore` the developer already has.
 *
 * 0.9.2 release test (N-RB1): init's merge had a short list of its own (`.supatype/` and
 * `.env.*.local`) and this module's returned as soon as `.supatype/` was present, so in an existing
 * create-vite or create-expo-app app `.env`, which holds the service role key, was not ignored.
 * `missing` is {@link missingSupatypeIgnores} of `content`, for a caller that has it already.
 */
export function withSupatypeIgnores(content: string, missing = missingSupatypeIgnores(content)): string {
  if (missing.length === 0) return content
  const eol = content.includes("\r\n") ? "\r\n" : "\n"
  const block = [SUPATYPE_GITIGNORE_MARKER, ...missing, ""].join(eol)
  if (content === "") return block
  return `${content}${content.endsWith("\n") ? "" : eol}${eol}${block}`
}

export function ensureSupatypeGitignore(cwd: string, opts?: { silent?: boolean }): boolean {
  const gitignorePath = resolve(cwd, ".gitignore")
  if (!existsSync(gitignorePath)) {
    // `.env` is not repeated here: the block below already carries it, along with the
    // `.env.local` patterns it does not cover.
    writeFileSync(gitignorePath, `node_modules/\ndist/\n${SUPATYPE_GITIGNORE_BLOCK}`, "utf8")
    if (!opts?.silent) console.warn("Created .gitignore with Supatype's paths (.env and .supatype/link.json hold secrets).")
    return true
  }
  const content = readFileSync(gitignorePath, "utf8")
  const missing = missingSupatypeIgnores(content)
  if (missing.length === 0) return true
  writeFileSync(gitignorePath, withSupatypeIgnores(content, missing), "utf8")
  if (opts?.silent) return true
  console.warn(`Added ${missing.join(", ")} to .gitignore (never commit them: .env and .supatype/link.json hold secrets).`)
  const notice = negationOverrideNotice(content, missing)
  if (notice !== undefined) console.warn(notice)
  return true
}

/**
 * One line when the project's `.gitignore` leaves out any path `link --fix-gitignore` would add.
 *
 * 0.9.2 release test round 2 (R2-S7): this checked only `.supatype/`, so `link` said nothing about a
 * `.env`, which holds the service role key, that git would commit.
 */
export function warnIfLinkNotGitignored(cwd: string): void {
  const gitignorePath = resolve(cwd, ".gitignore")
  const content = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : ""
  const missing = missingSupatypeIgnores(content)
  if (missing.length === 0) return
  console.warn(
    `⚠  .gitignore does not ignore ${missing.join(", ")} (.env and .supatype/link.json hold secrets); run supatype link --fix-gitignore to add them.`,
  )
}
