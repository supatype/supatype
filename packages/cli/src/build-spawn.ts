/**
 * How the CLI runs an app's own build command: `supatype build` and `deploy`'s build step.
 *
 * Never with `process.execPath`, which is the CLI itself when it runs as a compiled binary (#28):
 * the build script goes through the project's package manager, and a command given after `--` runs
 * as given. On Windows both go through cmd.exe, which is how `npm`, `pnpm` and a `node_modules/.bin`
 * shim (each a `.cmd` file) are found at all; Node refuses to start a `.cmd` without a shell.
 */

import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { delimiter, dirname, join } from "node:path"
import { detectPackageManager } from "./app/framework.js"
import { parsePackageJson } from "./package-json.js"

/** One program to start, and how. */
export interface BuildSpawn {
  file: string
  args: string[]
  shell: boolean
  /** The command as the person would type it, for saying what runs. */
  describe: string
}

/** Nothing to run: no command given, and no build script to fall back to or one that cannot be run. */
export class NoBuildCommand extends Error {
  constructor(problem: string) {
    super(
      `${problem}. Put the real build command (\`vite build\`, \`next build\`) in package.json's "build" ` +
        "script, or after --: supatype build -- <command>",
    )
    this.name = "NoBuildCommand"
  }
}

/** An argument as cmd.exe reads it back: quoted when it holds anything cmd.exe would act on. */
function cmdArg(arg: string): string {
  return /^[\w\-.,:/\\=@+]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`
}

/** `argv` to run in `platform`'s way: as given on POSIX, through cmd.exe on Windows. */
export function commandSpawn(argv: readonly string[], platform: NodeJS.Platform = process.platform): BuildSpawn {
  const [file, ...args] = argv
  if (file === undefined) throw new NoBuildCommand("No command to run")
  const describe = argv.join(" ")
  if (platform !== "win32") return { file, args, shell: false, describe }
  return { file: argv.map(cmdArg).join(" "), args: [], shell: true, describe }
}

/** The `build` script of the package.json in `dir`, run through the project's package manager. */
function scriptSpawn(dir: string, platform: NodeJS.Platform): BuildSpawn {
  const path = join(dir, "package.json")
  if (!existsSync(path)) throw new NoBuildCommand(`No package.json in ${dir}, so no build script to run`)
  if (!parsePackageJson(readFileSync(path, "utf8")).scripts["build"]) {
    throw new NoBuildCommand(`${path} has no "build" script`)
  }
  return commandSpawn([detectPackageManager(dir), "run", "build"], platform)
}

/** What `supatype build` runs in `dir`: the command given, else the package.json build script. */
export function buildSpawn(dir: string, command: readonly string[], platform: NodeJS.Platform = process.platform): BuildSpawn {
  return command.length > 0 ? commandSpawn(command, platform) : scriptSpawn(dir, platform)
}

/**
 * `env` with every `node_modules/.bin` from `dir` up first on its PATH, as `npm run` does, so a
 * command after `--` (`next build`) finds the project's own copy. Windows spells the name `Path`.
 */
export function withProjectBins(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH"
  const bins: string[] = []
  for (let at = dir; ; at = dirname(at)) {
    bins.push(join(at, "node_modules", ".bin"))
    if (dirname(at) === at) break
  }
  return { ...env, [key]: [...bins, env[key] ?? ""].filter((part) => part !== "").join(delimiter) }
}

/**
 * Run `program` in `cwd` with `env`, its output on this terminal, and resolve with its exit code: 1
 * when a signal ended it. Rejects when it could not be started at all, naming it.
 */
export function runBuildProcess(program: BuildSpawn, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolveCode, reject) => {
    const child = spawn(program.file, program.args, { cwd, env, stdio: "inherit", shell: program.shell })
    child.once("error", (err) => reject(new Error(`Could not start \`${program.describe}\`: ${err.message}`, { cause: err })))
    child.once("close", (code) => resolveCode(code ?? 1))
  })
}
