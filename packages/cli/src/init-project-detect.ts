import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { parsePackageJson, type PackageJson } from "./package-json.js"
import { findNextFreePort, type PortInUse } from "./dev-ports.js"
import { isLoopbackPortInUse } from "./postgres-ctl.js"

/** Every name Vite looks for its config under. */
export const VITE_CONFIG_NAMES = [
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.cjs",
  "vite.config.mts",
  "vite.config.cts",
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
  /** package.json lists Vite itself, so init adds none and keeps the app's own. */
  declaresVite: boolean
  hasViteConfig: boolean
  viteDevUrl: string
  staticDir: string
  /** The scripts the project's package.json already has, before init adds its own. */
  packageScripts: Record<string, string>
  /** Human-readable bullets for the init wizard. */
  summaryLines: string[]
}

/** The project's package.json, or undefined when it has none or it is not JSON (init skips one that is not). */
export function readPackageJson(cwd: string): PackageJson | undefined {
  const pkgPath = join(cwd, "package.json")
  if (!existsSync(pkgPath)) return undefined
  try {
    return parsePackageJson(readFileSync(pkgPath, "utf8"))
  } catch {
    return undefined
  }
}

/** The vite range a package.json declares, from devDependencies first. */
export function declaredVite(pkg: PackageJson | undefined): string | undefined {
  return pkg?.devDependencies["vite"] ?? pkg?.dependencies["vite"]
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

/** Inspect `cwd` before init prompts, Vite, static dir, existing Supatype config. */
export function detectProjectSetup(cwd: string): DetectedProjectSetup {
  let entries: string[] = []
  try {
    entries = readdirSync(cwd).filter((entry) => entry !== ".git")
  } catch {
    entries = []
  }

  const hasExistingFiles = entries.length > 0
  const pkg = readPackageJson(cwd)
  const hasViteConfig = VITE_CONFIG_NAMES.some((name) => existsSync(join(cwd, name)))
  const declaresVite = declaredVite(pkg) !== undefined
  const hasVite = hasViteConfig || declaresVite
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
    declaresVite,
    hasViteConfig,
    viteDevUrl,
    staticDir,
    packageScripts: pkg?.scripts ?? {},
    summaryLines,
  }
}

/**
 * `detected` with a Vite port that is free now: the detected one, or the next free after it, with
 * a summary line saying why it moved. 0.9.1 release test (FF21): init proposed 5173 while another
 * project's app held it, and dev's App URL then served that app. Either loopback counts, because
 * Vite on Node's default `localhost` listens on [::1] alone on Windows. Checked with or without Vite
 * in the project: init offers Vite, and scaffolds its config with this port, either way.
 */
export async function withFreeVitePort(
  detected: DetectedProjectSetup,
  inUse: PortInUse = isLoopbackPortInUse,
): Promise<DetectedProjectSetup> {
  const url = new URL(detected.viteDevUrl)
  const port = Number(url.port)
  const free = await findNextFreePort(port, undefined, inUse)
  if (free === port) return detected
  url.port = String(free)
  return {
    ...detected,
    viteDevUrl: url.origin,
    summaryLines: [...detected.summaryLines, `Port ${port} is in use, so Vite is offered ${free}`],
  }
}
