import semver from "semver"
import { isJsonObject } from "@supatype/shared"
import type { InitDependencyVersions } from "./init-dependency-versions.js"
import { runsSupatypeDev } from "./dev-self-start.js"

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

/**
 * `supatype generate` when the CLI is installed, and nothing when it is not: a bin of
 * `@supatype/client` (bin/supatype-prepare.js there says how it finds the CLI). The client is a
 * production dependency, so the bin is there on a production install, where the CLI is not.
 *
 * It was once a script written into the project's package.json in full, which no upgrade could
 * fix: each project kept the copy it was made with.
 */
export const PREPARE_COMMAND = "supatype-prepare"

/**
 * The scripts every Supatype project gets, written by `init` into a new package.json and merged
 * into an existing one, so the two cannot drift: the merge once ran `tsx seed.ts`, which loads the
 * seed module without calling it, while new projects ran `supatype seed`.
 */
export const CORE_SCRIPTS = {
  dev: "supatype dev",
  push: "supatype push",
  seed: "supatype seed",
  prepare: PREPARE_COMMAND,
} as const

/**
 * Vite serves the app in development, and `build` writes the `./dist` that `app.static_dir` serves
 * in production. Without `build` nothing ever produced `./dist`.
 */
const VITE_SCRIPTS = { vite: "vite", build: "vite build" } as const

const FUNCTIONS_SCRIPTS = { functions: "supatype functions serve" } as const

/** The Vite major that current `@vitejs/plugin-react` requires as a peer. */
export const VITE_RANGE = "^8"

/**
 * Development-time only, so devDependencies. schema/index.ts imports @supatype/types with
 * `import type`, which is erased at build; supatype.config.ts imports defineConfig, which only the
 * CLI evaluates; seed.ts is run by `supatype seed`. Nothing `supatype push` or `supatype generate`
 * writes refers to either package. The generated client imports @supatype/client at runtime, so
 * that one is a real dependency.
 *
 * In dependencies they were installed by `npm install --omit=dev`, so every production install of
 * a Supatype app pulled the CLI to support three files that never run in production.
 *
 * No tsx: the CLI's program runs the project's TypeScript itself. TypeScript stays for the editor
 * and for `tsc`, and `defineConfig`'s module imports it.
 */
function toolDependencies(deps: InitDependencyVersions, opts: MergePackageJsonOptions): Record<string, string> {
  return {
    "@supatype/cli": `^${deps.cli}`,
    "@supatype/types": `^${deps.types}`,
    typescript: "^5",
    ...(opts.app.viteDevUrl ? { vite: VITE_RANGE } : {}),
  }
}

/** What decides which scripts a project gets. */
type ScriptOptions = Pick<MergePackageJsonOptions, "app" | "helloFunction">

function projectScripts(opts: ScriptOptions): Record<string, string> {
  return {
    ...CORE_SCRIPTS,
    ...(opts.app.viteDevUrl ? VITE_SCRIPTS : {}),
    ...(opts.helloFunction ? FUNCTIONS_SCRIPTS : {}),
  }
}

/** The package.json `init` writes for a new project. */
export function scaffoldPackageJson(opts: MergePackageJsonOptions, deps: InitDependencyVersions): string {
  const pkg: PackageJson = {
    name: opts.projectName,
    version: NEW_PROJECT_VERSION,
    private: true,
    type: "module",
    scripts: projectScripts(opts),
    dependencies: { [CLIENT]: clientRange(undefined, deps.client) },
    devDependencies: toolDependencies(deps, opts),
  }
  return `${JSON.stringify(pkg, null, 2)}\n`
}

type Section = Record<string, string> | undefined

/** Each of `wanted` that none of `present` already names. */
function absentFrom(wanted: Record<string, string>, ...present: Section[]): Record<string, string> {
  return Object.fromEntries(Object.entries(wanted).filter(([key]) => present.every((p) => p?.[key] === undefined)))
}

const CLIENT = "@supatype/client"

/** The `prepare` earlier releases of `init` wrote, which fails every production install. */
const EARLIER_PREPARE = "supatype generate"

/** The version `init` writes for a new project, or adds to an existing one that has none. */
const NEW_PROJECT_VERSION = "0.1.0"

/**
 * `prepare` as a Supatype project needs it: {@link PREPARE_COMMAND} in place of the one earlier
 * releases of `init` wrote, after a `prepare` of the project's own (husky, say) that does not run
 * either already, and on its own when there is none. A project's own `prepare` used to be kept as
 * it was, so a fresh clone never generated the gitignored seed builder.
 */
export function supatypePrepare(existing: string | undefined): string {
  if (existing === undefined || existing.trim() === "" || existing.trim() === EARLIER_PREPARE) return PREPARE_COMMAND
  if (existing.includes(PREPARE_COMMAND) || existing.includes(EARLIER_PREPARE)) return existing
  return `${existing} && ${PREPARE_COMMAND}`
}

function withPrepare(scripts: Record<string, string> | undefined): Record<string, string> {
  return { ...scripts, prepare: supatypePrepare(scripts?.["prepare"]) }
}

/**
 * The script among `scripts` that runs `supatype dev`: `supatype:dev` when the merge put it beside
 * a dev script of the project's own, else `dev`.
 */
export function supatypeDevScript(scripts: unknown): string {
  const runs = (key: string) => {
    const body = isJsonObject(scripts) ? scripts[key] : undefined
    return typeof body === "string" && runsSupatypeDev(body)
  }
  return !runs("dev") && runs("supatype:dev") ? "supatype:dev" : "dev"
}

/**
 * The project's @supatype/client range, as `prepare` needs it: at least `floor`, the client `init`
 * would pick, since an older one may predate `supatype-prepare`. A range whose lowest version, as
 * npm's own `semver` reads it, is at or above the floor is kept. So is a spec that is not a range,
 * such as `workspace:*`, a path, a git URL or a tag. Any other range has its lower end raised and
 * keeps its upper end, so a project on a newer client than the floor is not moved down to it:
 * `>=0.5.0` becomes `>=0.5.0 >=0.9.0`. A range with nothing left at or above the floor becomes
 * `^floor`.
 */
function clientRange(listed: string | undefined, floor: string): string {
  if (listed === undefined) return `^${floor}`
  if (semver.validRange(listed) === null || semver.valid(floor) === null) return listed
  const lowest = semver.minVersion(listed)
  if (lowest !== null && semver.gte(lowest, floor)) return listed
  const raised = listed
    .split("||")
    .map((alternative) => `${alternative.trim()} >=${floor}`)
    .filter((alternative) => semver.minVersion(alternative) !== null)
  return raised.length > 0 ? raised.join(" || ") : `^${floor}`
}

/**
 * The client in `dependencies` at a range `prepare` can run with, and out of `devDependencies`: a
 * production install leaves those out, and `supatype-prepare` with them.
 */
function withClient(pkg: PackageJson, floor: string): Required<Pick<PackageJson, "dependencies" | "devDependencies">> {
  const { [CLIENT]: listedDev, ...devDependencies } = pkg.devDependencies ?? {}
  const range = clientRange(pkg.dependencies?.[CLIENT] ?? listedDev, floor)
  return { dependencies: { ...pkg.dependencies, [CLIENT]: range }, devDependencies }
}

/**
 * The scripts a project has once `init` adds its own to `existing`: the project's own are kept, and
 * `supatype dev` goes in as `supatype:dev` when the project's `dev` is something else.
 */
export function mergeSupatypeScripts(existing: Section, opts: ScriptOptions): Record<string, string> {
  const scripts = { ...withPrepare(existing), ...absentFrom(projectScripts(opts), existing) }
  if (scripts.dev !== CORE_SCRIPTS.dev && scripts["supatype:dev"] === undefined) {
    scripts["supatype:dev"] = CORE_SCRIPTS.dev
  }
  return scripts
}

/** Merge Supatype deps/scripts into an existing package.json object, keeping what it already has. */
export function mergeSupatypePackageJson(
  pkg: PackageJson,
  opts: MergePackageJsonOptions,
  deps: InitDependencyVersions,
): PackageJson {
  const scripts = mergeSupatypeScripts(pkg.scripts, opts)
  const { dependencies, devDependencies } = withClient(pkg, deps.client)
  return {
    ...pkg,
    name: pkg.name || opts.projectName,
    version: pkg.version || NEW_PROJECT_VERSION,
    private: pkg.private ?? true,
    type: pkg.type || "module",
    scripts,
    dependencies,
    // A tool the project already lists in either section stays where it is.
    devDependencies: {
      ...devDependencies,
      ...absentFrom(toolDependencies(deps, opts), pkg.dependencies, pkg.devDependencies),
    },
  }
}
