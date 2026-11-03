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

/**
 * `supatype generate` when the CLI is installed, and nothing when it is not.
 *
 * The generated files are gitignored, so a fresh clone has to produce them before anything can
 * import them. A production install leaves out development dependencies, the CLI among them, but
 * npm still runs `prepare`, and a bare `supatype generate` failed it with `supatype: not found`.
 * Nothing needs generating there: the build that imports the files ran with everything installed.
 * Prisma's client skips its generate the same way when the Prisma CLI is not installed.
 *
 * The CLI is looked for in the folders Node looks in for a package (`module.paths`): node_modules
 * beside the project and in each folder above it, where a workspace hoists it, nearest first. Not on
 * NODE_PATH or in the global folders, which belong to no project. It is found by its folder, not
 * through its `exports`, which name no package.json in any release. A folder that cannot be read is
 * passed over, as Node passes it over. A CLI that is not installed is skipped. A CLI folder that is
 * there but broken, such as a link into a pruned pnpm store, fails the install, as a generate that
 * fails does.
 *
 * The script is Node rather than shell, so sh and cmd.exe read it alike, and it holds no character
 * either shell would read inside its double quotes (tests/init-package-json.test.ts holds it to
 * that). Yarn 2 and later do not run a project's own `prepare` on install, so there
 * `supatype generate` is run by hand, as it always was.
 */
export const PREPARE_COMMAND =
  "node -e \"" +
  [
    "const {join}=require('path'),{lstatSync}=require('fs')",
    "function has(c){try{return lstatSync(c)}catch{}}",
    "const d=module.paths.map(function(p){return join(p,'@supatype','cli')}).find(has)",
    "if(d===undefined)process.exit(0)",
    "const bin=join(d,'bin','supatype.js')",
    "const r=require('child_process').spawnSync(process.execPath,[bin,'generate'],{stdio:'inherit'})",
    "if(r.error)console.error(r.error.message)",
    "process.exit(r.status??1)",
  ].join(";") +
  "\""

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

function projectScripts(opts: MergePackageJsonOptions): Record<string, string> {
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
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: projectScripts(opts),
    dependencies: { "@supatype/client": `^${deps.client}` },
    devDependencies: toolDependencies(deps, opts),
  }
  return `${JSON.stringify(pkg, null, 2)}\n`
}

type Section = Record<string, string> | undefined

/** Each of `wanted` that none of `present` already names. */
function absentFrom(wanted: Record<string, string>, ...present: Section[]): Record<string, string> {
  return Object.fromEntries(Object.entries(wanted).filter(([key]) => present.every((p) => p?.[key] === undefined)))
}

/** Merge Supatype deps/scripts into an existing package.json object, keeping what it already has. */
export function mergeSupatypePackageJson(
  pkg: PackageJson,
  opts: MergePackageJsonOptions,
  deps: InitDependencyVersions,
): PackageJson {
  const scripts = { ...pkg.scripts, ...absentFrom(projectScripts(opts), pkg.scripts) }
  if (scripts.dev !== CORE_SCRIPTS.dev && scripts["supatype:dev"] === undefined) {
    scripts["supatype:dev"] = CORE_SCRIPTS.dev
  }
  return {
    ...pkg,
    name: pkg.name || opts.projectName,
    private: pkg.private ?? true,
    type: pkg.type || "module",
    scripts,
    dependencies: {
      ...pkg.dependencies,
      ...absentFrom({ "@supatype/client": `^${deps.client}` }, pkg.dependencies, pkg.devDependencies),
    },
    // A tool the project already lists in either section stays where it is.
    devDependencies: {
      ...pkg.devDependencies,
      ...absentFrom(toolDependencies(deps, opts), pkg.dependencies, pkg.devDependencies),
    },
  }
}
