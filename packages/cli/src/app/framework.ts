/**
 * Framework auto-detection and build configuration.
 * Inspects package.json to determine the framework, then resolves
 * build command, output directory, and SPA mode defaults.
 */

import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { AppConfig, AppFramework } from "../config.js"

export interface ResolvedAppConfig {
  framework: AppFramework
  directory: string
  buildCommand: string
  outputDirectory: string
  spa: boolean
  env: Record<string, string>
  headers: Record<string, string>
}

interface FrameworkDefaults {
  buildCommand: string
  outputDirectory: string
  spa: boolean
}

const FRAMEWORK_DEFAULTS: Record<AppFramework, FrameworkDefaults> = {
  nextjs: { buildCommand: "next build", outputDirectory: "out", spa: false },
  astro: { buildCommand: "astro build", outputDirectory: "dist", spa: false },
  vite: { buildCommand: "vite build", outputDirectory: "dist", spa: true },
  "remix-spa": { buildCommand: "remix vite:build", outputDirectory: "build/client", spa: true },
  sveltekit: { buildCommand: "vite build", outputDirectory: "build", spa: false },
  nuxt: { buildCommand: "nuxt generate", outputDirectory: "dist", spa: false },
  static: { buildCommand: "", outputDirectory: ".", spa: false },
}

// Maps package.json dependency names to framework identifiers
const FRAMEWORK_DETECTION: Array<{ dep: string; framework: AppFramework }> = [
  { dep: "next", framework: "nextjs" },
  { dep: "astro", framework: "astro" },
  { dep: "@remix-run/react", framework: "remix-spa" },
  { dep: "@sveltejs/kit", framework: "sveltekit" },
  { dep: "nuxt", framework: "nuxt" },
  // Vite last — many frameworks use Vite under the hood
  { dep: "vite", framework: "vite" },
]

/**
 * Detect the framework from package.json dependencies.
 */
export function detectFramework(appDir: string): AppFramework | undefined {
  const pkgPath = join(appDir, "package.json")
  if (!existsSync(pkgPath)) return undefined

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }

  for (const { dep, framework } of FRAMEWORK_DETECTION) {
    if (dep in allDeps) return framework
  }

  // Check for plain HTML
  if (existsSync(join(appDir, "index.html"))) return "static"

  return undefined
}

/**
 * Detect if the project is a monorepo.
 */
export function detectMonorepo(cwd: string): { isMonorepo: boolean; tool?: string } {
  if (existsSync(join(cwd, "turbo.json"))) return { isMonorepo: true, tool: "turbo" }
  if (existsSync(join(cwd, "pnpm-workspace.yaml"))) return { isMonorepo: true, tool: "pnpm" }
  if (existsSync(join(cwd, "nx.json"))) return { isMonorepo: true, tool: "nx" }
  return { isMonorepo: false }
}

/**
 * Detect package manager from lockfiles.
 */
export function detectPackageManager(dir: string): "npm" | "pnpm" | "yarn" {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(join(dir, "yarn.lock"))) return "yarn"
  return "npm"
}

/**
 * Resolve the full app configuration from user config + auto-detection.
 */
export function resolveAppConfig(
  appConfig: AppConfig | undefined,
  cwd: string,
): ResolvedAppConfig {
  const directory = resolve(cwd, appConfig?.directory || ".")

  // Framework detection
  let framework = appConfig?.framework
  if (!framework) {
    framework = detectFramework(directory)
    if (!framework) {
      throw new Error(
        "Could not detect frontend framework.\n" +
        "Set app.framework in supatype.config.ts, or ensure package.json is present.",
      )
    }
  }

  const defaults = FRAMEWORK_DEFAULTS[framework]

  // Build command
  let buildCommand = appConfig?.buildCommand || defaults.buildCommand
  const mono = detectMonorepo(cwd)
  if (mono.isMonorepo && mono.tool === "turbo" && !appConfig?.buildCommand) {
    // In a Turborepo, run build via turbo from workspace root
    const appDirRelative = appConfig?.directory || "."
    if (appDirRelative !== ".") {
      const pkgName = getPackageName(directory)
      if (pkgName) {
        buildCommand = `turbo run build --filter=${pkgName}`
      }
    }
  }

  return {
    framework,
    directory,
    buildCommand,
    outputDirectory: resolve(directory, appConfig?.outputDirectory || defaults.outputDirectory),
    spa: appConfig?.spa ?? defaults.spa,
    env: appConfig?.env ?? {},
    headers: appConfig?.headers ?? {},
  }
}

function getPackageName(dir: string): string | undefined {
  const pkgPath = join(dir, "package.json")
  if (!existsSync(pkgPath)) return undefined
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string }
  return pkg.name
}

/**
 * Validate that the framework is configured for static output.
 * Returns an error message if SSR mode is detected.
 */
export function validateStaticMode(framework: AppFramework, appDir: string): string | null {
  if (framework === "nextjs") {
    // Check for output: 'export' in next.config.js/mjs/ts
    for (const name of ["next.config.js", "next.config.mjs", "next.config.ts"]) {
      const configPath = join(appDir, name)
      if (existsSync(configPath)) {
        const content = readFileSync(configPath, "utf8")
        if (!content.includes("export")) {
          return (
            "Supatype currently supports Next.js static export only.\n" +
            "Add `output: 'export'` to your next.config.js,\n" +
            "or deploy your frontend to Vercel for SSR support."
          )
        }
      }
    }
  }

  if (framework === "astro") {
    const configPath = join(appDir, "astro.config.mjs")
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, "utf8")
      if (content.includes("output: 'server'") || content.includes("output: \"server\"")) {
        return (
          "Supatype currently supports Astro static sites only.\n" +
          "Remove `output: 'server'` from astro.config.mjs,\n" +
          "or deploy your frontend separately for SSR support."
        )
      }
    }
  }

  if (framework === "sveltekit") {
    const pkgPath = join(appDir, "package.json")
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        devDependencies?: Record<string, string>
      }
      if (!pkg.devDependencies?.["@sveltejs/adapter-static"]) {
        return (
          "Supatype requires @sveltejs/adapter-static for SvelteKit.\n" +
          "Install it: npm install -D @sveltejs/adapter-static"
        )
      }
    }
  }

  return null
}

/**
 * Validate the build output.
 */
export function validateBuildOutput(outputDir: string, maxSizeMb: number): string | null {
  if (!existsSync(outputDir)) {
    return `Build output directory not found: ${outputDir}`
  }

  // Check for at least one HTML file
  const hasHtml = findHtmlFile(outputDir)
  if (!hasHtml) {
    return `No HTML files found in build output: ${outputDir}`
  }

  // Check total size
  const sizeMb = getDirSizeMb(outputDir)
  if (sizeMb > maxSizeMb) {
    return `Build output ${sizeMb.toFixed(1)}MB exceeds limit of ${maxSizeMb}MB`
  }

  if (sizeMb > 500) {
    console.warn(
      `Warning: Build output is ${sizeMb.toFixed(1)}MB. This may include unoptimised assets or node_modules.`,
    )
  }

  return null
}

function findHtmlFile(dir: string): boolean {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs")
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".html")) return true
    if (entry.isDirectory()) {
      if (findHtmlFile(join(dir, entry.name))) return true
    }
  }
  return false
}

function getDirSizeMb(dir: string): number {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs")
  let size = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isFile()) size += statSync(path).size
    else if (entry.isDirectory()) size += getDirSizeMb(path) * 1024 * 1024
  }
  return size / (1024 * 1024)
}
