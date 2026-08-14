/**
 * Detect how the supatype CLI was installed (npm, Homebrew, standalone CDN).
 */

export type CliInstallMethod = "npm" | "homebrew" | "standalone"

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/")
}

/** The running binary sits in an npm or workspace layout. */
function hasNpmInstallPath(): boolean {
  const main = normalizePath(process.argv[1] ?? "")
  return (
    main.includes("node_modules") ||
    main.includes("/dist/cli") ||
    main.includes("/bin/supatype.js")
  )
}

/** Launched through an npm/pnpm/yarn script, whatever the binary's own layout. */
function ranUnderPackageManager(): boolean {
  return Boolean(process.env["npm_execpath"]) || Boolean(process.env["npm_lifecycle_event"])
}

/** npm global, project dependency, or monorepo workspace build. */
export function looksLikeNpmOrWorkspaceCLI(): boolean {
  return hasNpmInstallPath() || ranUnderPackageManager()
}

/** Homebrew / Linuxbrew Cellar layout. */
export function looksLikeHomebrewCLI(): boolean {
  const main = normalizePath(process.argv[1] ?? "")
  if (!main) return false

  if (/(?:^|\/)Cellar\/supatype\//.test(main)) return true

  const cellar = process.env["HOMEBREW_CELLAR"]
  if (cellar && normalizePath(main).startsWith(normalizePath(cellar) + "/") && main.includes("/supatype/")) {
    return true
  }

  return false
}

/**
 * Which installer owns the running binary — this decides what `self-update`
 * tells the user to run, so it has to describe the binary on disk.
 *
 * Path shape wins over `npm_*` in the environment: those are set whenever the
 * CLI is invoked from a package script, which says nothing about how the binary
 * got there. Trusting them meant a Homebrew or curl install called from an npm
 * script was told to update itself with npm.
 */
export function detectCliInstallMethod(): CliInstallMethod {
  if (hasNpmInstallPath()) return "npm"
  if (looksLikeHomebrewCLI()) return "homebrew"
  if (isStandalonePath()) return "standalone"
  if (ranUnderPackageManager()) return "npm"
  return "standalone"
}

/** The `curl | sh` installer's default target. */
function isStandalonePath(): boolean {
  const main = normalizePath(process.argv[1] ?? "")
  return main.includes("/.supatype/bin/")
}
