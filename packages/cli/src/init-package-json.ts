import type { InitDependencyVersions } from "./init-dependency-versions.js"

export interface MergePackageJsonOptions {
  projectName: string
  app: { viteDevUrl?: string; mode: string }
  helloFunction: boolean
}

type PackageJson = {
  name?: string
  private?: boolean
  type?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const CORE_SCRIPTS = {
  dev: "supatype dev",
  push: "supatype push",
  seed: "tsx seed.ts",
} as const

/** Merge Supatype deps/scripts into an existing package.json object. */
export function mergeSupatypePackageJson(
  pkg: PackageJson,
  opts: MergePackageJsonOptions,
  deps: InitDependencyVersions,
): PackageJson {
  const next: PackageJson = { ...pkg }

  if (!next.name) next.name = opts.projectName
  if (next.private === undefined) next.private = true
  if (!next.type) next.type = "module"

  const scripts = { ...(next.scripts ?? {}) }
  for (const [key, value] of Object.entries(CORE_SCRIPTS)) {
    if (scripts[key] === undefined) scripts[key] = value
  }
  if (scripts.dev !== CORE_SCRIPTS.dev && scripts["supatype:dev"] === undefined) {
    scripts["supatype:dev"] = CORE_SCRIPTS.dev
  }
  if (opts.app.viteDevUrl && scripts.vite === undefined) {
    scripts.vite = "vite"
  }
  if (opts.helloFunction && scripts.functions === undefined) {
    scripts.functions = "supatype functions serve"
  }
  next.scripts = scripts

  const dependencies = { ...(next.dependencies ?? {}) }
  if (dependencies["@supatype/cli"] === undefined) dependencies["@supatype/cli"] = `^${deps.cli}`
  if (dependencies["@supatype/types"] === undefined) dependencies["@supatype/types"] = `^${deps.types}`
  next.dependencies = dependencies

  const devDependencies = { ...(next.devDependencies ?? {}) }
  if (devDependencies.tsx === undefined) devDependencies.tsx = "^4.19.2"
  if (devDependencies.typescript === undefined) devDependencies.typescript = "^5"
  if (opts.app.viteDevUrl && devDependencies.vite === undefined) devDependencies.vite = "^6"
  next.devDependencies = devDependencies

  return next
}
