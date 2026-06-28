import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const VITE_CONFIG_NAMES = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
] as const

const SUPATYPE_CONFIG_NAMES = [
  "supatype.config.ts",
  "supatype.config.js",
  "supatype.config.mjs",
] as const

export interface DetectedProjectSetup {
  /** Directory has files other than `.git`. */
  hasExistingFiles: boolean
  hasSupatypeConfig: boolean
  hasVite: boolean
  hasViteConfig: boolean
  viteDevUrl: string
  staticDir: string
  /** Human-readable bullets for the init wizard. */
  summaryLines: string[]
}

function hasPackageVite(cwd: string): boolean {
  const pkgPath = join(cwd, "package.json")
  if (!existsSync(pkgPath)) return false
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    return Boolean(pkg.devDependencies?.["vite"] ?? pkg.dependencies?.["vite"])
  } catch {
    return false
  }
}

function readVitePort(cwd: string): number {
  for (const name of VITE_CONFIG_NAMES) {
    const path = join(cwd, name)
    if (!existsSync(path)) continue
    const src = readFileSync(path, "utf8")
    const portMatch = src.match(/port:\s*(\d+)/)
    if (portMatch?.[1]) {
      const port = Number.parseInt(portMatch[1], 10)
      if (Number.isInteger(port) && port > 0) return port
    }
  }
  return 5173
}

function detectStaticDir(cwd: string): string {
  if (existsSync(join(cwd, "dist", "index.html"))) return "./dist"
  if (existsSync(join(cwd, "public", "index.html"))) return "./public"
  if (existsSync(join(cwd, "dist"))) return "./dist"
  if (existsSync(join(cwd, "public"))) return "./public"
  return "./public"
}

/** Inspect `cwd` before init prompts — Vite, static dir, existing Supatype config. */
export function detectProjectSetup(cwd: string): DetectedProjectSetup {
  let entries: string[] = []
  try {
    entries = readdirSync(cwd).filter((entry) => entry !== ".git")
  } catch {
    entries = []
  }

  const hasExistingFiles = entries.length > 0
  const hasViteConfig = VITE_CONFIG_NAMES.some((name) => existsSync(join(cwd, name)))
  const hasVite = hasViteConfig || hasPackageVite(cwd)
  const viteDevUrl = `http://127.0.0.1:${readVitePort(cwd)}`
  const staticDir = detectStaticDir(cwd)
  const hasSupatypeConfig = SUPATYPE_CONFIG_NAMES.some((name) => existsSync(join(cwd, name)))

  const summaryLines: string[] = []
  if (hasSupatypeConfig) summaryLines.push("supatype.config already present")
  if (hasViteConfig) summaryLines.push(`Vite config found (${viteDevUrl})`)
  else if (hasVite) summaryLines.push(`Vite dependency in package.json (${viteDevUrl})`)
  if (existsSync(join(cwd, staticDir.replace(/^\.\//, "")))) {
    summaryLines.push(`static assets in ${staticDir}`)
  }
  if (existsSync(join(cwd, "package.json"))) summaryLines.push("package.json present")

  return {
    hasExistingFiles,
    hasSupatypeConfig,
    hasVite,
    hasViteConfig,
    viteDevUrl,
    staticDir,
    summaryLines,
  }
}
