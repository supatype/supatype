import { isJsonObject } from "@supatype/shared"
import type { InitDependencyVersions } from "./init-dependency-versions.js"

export interface MergePackageJsonOptions {
  projectName: string
  app: { viteDevUrl?: string; mode: string }
  helloFunction: boolean
}

type PackageJson = {
  name?: string
  version?: string
  private?: boolean
  type?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

type PackageJsonOptions = Omit<MergePackageJsonOptions, "projectName">

/** The version init writes for a new project, or adds to an existing one that has none. */
const NEW_PROJECT_VERSION = "0.1.0"

const DEV_SCRIPT = "supatype dev"

const GENERATE_SCRIPT = "supatype generate"

/**
 * `prepare` with `supatype generate` after the project's own, when it does not run it already. A
 * prepare of the project's own (husky, say) used to be kept as it was, so a fresh clone never
 * generated the gitignored seed builder.
 */
function preparingGenerate(prepare: string): string {
  return prepare.includes(GENERATE_SCRIPT) ? prepare : `${prepare} && ${GENERATE_SCRIPT}`
}

/**
 * The scripts init gives a project. A new package.json and one merged into an existing project
 * both read them from here: they were two copies, and the merge had drifted to `tsx seed.ts` (which
 * imports the seed and runs nothing) with no `prepare`.
 */
function supatypeScripts(opts: PackageJsonOptions): Record<string, string> {
  return {
    dev: DEV_SCRIPT,
    push: "supatype push",
    seed: "supatype seed",
    // The generated seed builder is gitignored, so a fresh clone has to produce it before
    // anything can import it. `generate` is fully offline, which is the condition that makes
    // gitignoring generated code reasonable rather than a trap; without this hook it would be
    // one, and the failure would be a missing module rather than anything naming the remedy.
    prepare: GENERATE_SCRIPT,
    ...(opts.app.viteDevUrl ? { vite: "vite", build: "vite build" } : {}),
    ...(opts.helloFunction ? { functions: "supatype functions serve" } : {}),
  }
}

/**
 * The generated client (supatype/generated/client.ts) imports @supatype/client at runtime, so that
 * one is a real dependency.
 */
function supatypeDependencies(deps: InitDependencyVersions): Record<string, string> {
  return { "@supatype/client": `^${deps.client}` }
}

/**
 * The CLI and types are development-time only. Validated end to end against a real database:
 * schema/index.ts imports @supatype/types with `import type`, which is erased at build;
 * supatype.config.ts imports defineConfig, which only the CLI evaluates; and seed.ts is run by
 * `supatype seed`. Nothing `supatype push` or `supatype generate` writes refers to either package.
 *
 * In dependencies they were installed by `npm install --omit=dev`, so every production install of
 * a Supatype app pulled the whole CLI toolchain (ink, react, typescript, ts-morph, pg, tsx) to
 * support three files that never run in production.
 */
function supatypeDevDependencies(opts: PackageJsonOptions, deps: InitDependencyVersions): Record<string, string> {
  return {
    "@supatype/cli": `^${deps.cli}`,
    "@supatype/types": `^${deps.types}`,
    tsx: "^4.19.2",
    typescript: "^5",
    ...(opts.app.viteDevUrl ? { vite: `^${deps.vite}` } : {}),
  }
}

/** `existing` followed by each entry of `additions` it lacks and `keep` accepts; its own values win. */
function withMissing(
  existing: Record<string, string> | undefined,
  additions: Record<string, string>,
  keep: (key: string) => boolean = () => true,
): Record<string, string> {
  const merged = { ...(existing ?? {}) }
  for (const [key, value] of Object.entries(additions)) {
    if (merged[key] === undefined && keep(key)) merged[key] = value
  }
  return merged
}

/**
 * The script that runs `supatype dev` among `scripts`: `supatype:dev` when the merge put it beside
 * a dev script of the project's own, else `dev`.
 */
export function supatypeDevScript(scripts: unknown): string {
  const named = (key: string) => isJsonObject(scripts) && scripts[key] === DEV_SCRIPT
  return !named("dev") && named("supatype:dev") ? "supatype:dev" : "dev"
}

/** The package.json of a project init creates from nothing. */
export function newSupatypePackageJson(opts: MergePackageJsonOptions, deps: InitDependencyVersions): PackageJson {
  return {
    name: opts.projectName,
    version: NEW_PROJECT_VERSION,
    private: true,
    type: "module",
    scripts: supatypeScripts(opts),
    dependencies: supatypeDependencies(deps),
    devDependencies: supatypeDevDependencies(opts, deps),
  }
}

/** Merge Supatype deps and scripts into an existing package.json object, keeping whatever it has. */
export function mergeSupatypePackageJson(
  pkg: PackageJson,
  opts: MergePackageJsonOptions,
  deps: InitDependencyVersions,
): PackageJson {
  const next: PackageJson = { ...pkg }

  if (!next.name) next.name = opts.projectName
  if (!next.version) next.version = NEW_PROJECT_VERSION
  if (next.private === undefined) next.private = true
  if (!next.type) next.type = "module"

  const scripts = withMissing(next.scripts, supatypeScripts(opts))
  if (scripts.dev !== DEV_SCRIPT && scripts["supatype:dev"] === undefined) {
    scripts["supatype:dev"] = DEV_SCRIPT
  }
  if (scripts.prepare !== undefined) scripts.prepare = preparingGenerate(scripts.prepare)
  next.scripts = scripts

  // A package the project already lists, in either section, is left where it is.
  const unlisted = (name: string) => pkg.dependencies?.[name] === undefined && pkg.devDependencies?.[name] === undefined
  next.dependencies = withMissing(next.dependencies, supatypeDependencies(deps), unlisted)
  next.devDependencies = withMissing(next.devDependencies, supatypeDevDependencies(opts, deps), unlisted)
  return next
}
