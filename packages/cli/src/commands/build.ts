/**
 * `supatype build [--env <name>] [--allow-local] [-- <command...>]`: the app's production build,
 * given the deployment's API URL and anon key under every front-end name (frontend-values.ts).
 *
 * The values live only in the build's environment: nothing is written to a file. The build does
 * not start when either value is missing, and its exit code is this command's, so CI behaves as it
 * did before the wrapper.
 */

import type { Command } from "commander"
import { buildSpawn, NoBuildCommand, runBuildProcess, withProjectBins, type BuildSpawn } from "../build-spawn.js"
import { frontendEnv } from "../frontend-env.js"
import { describeFrontendSources, FrontendValuesRefused, resolveFrontendValues } from "../frontend-values.js"
import { error, info } from "../ui/messages.js"

export interface FrontendBuildOptions {
  env?: string | undefined
  allowLocal?: boolean | undefined
  /** Laid over this process's environment: the values are read from the result first, and the build inherits it. */
  processEnv?: NodeJS.ProcessEnv
}

export function registerBuild(program: Command): void {
  program
    .command("build")
    .description(
      "Run your app's production build with the deployment's API URL and anon key under every " +
        "front-end name (VITE_, PUBLIC_, NEXT_PUBLIC_, EXPO_PUBLIC_). Runs the package.json build " +
        "script unless a command follows --. Refuses to start when either value is missing",
    )
    .argument("[command...]", "The build command, after --: supatype build -- next build")
    .option("--env <name>", "Linked environment to build for (default: the link's default)")
    .option("--allow-local", "Build against a local stack's address, which a production build otherwise refuses")
    .action(async (command: string[], opts: { env?: string; allowLocal?: boolean }) => {
      process.exit(await buildOrRefuse(command, opts))
    })
}

/** {@link runFrontendBuild} in this directory, a refusal printed and exiting 1. */
async function buildOrRefuse(command: string[], opts: FrontendBuildOptions): Promise<number> {
  try {
    return await runFrontendBuild(process.cwd(), command, opts)
  } catch (err) {
    if (!(err instanceof FrontendValuesRefused || err instanceof NoBuildCommand)) throw err
    error(err.message)
    return 1
  }
}

/**
 * Set in every build this command runs. A package.json `"build": "supatype build"` run by a bare
 * `supatype build` would otherwise run the build script, which runs `supatype build`, without end.
 */
export const BUILD_ACTIVE_ENV = "SUPATYPE_BUILD_ACTIVE"

/** What a bare `supatype build` runs, or a refusal when it is already inside one ({@link BUILD_ACTIVE_ENV}). */
function buildProgram(cwd: string, command: readonly string[], env: NodeJS.ProcessEnv): BuildSpawn {
  if (command.length === 0 && env[BUILD_ACTIVE_ENV] === "1") {
    throw new NoBuildCommand("The package.json build script calls `supatype build` itself, so running it again would never end")
  }
  return buildSpawn(cwd, command)
}

/**
 * Run `command` (else the package.json build script) in `cwd` with the deployment's front-end
 * values, resolving with its exit code. Throws {@link FrontendValuesRefused} before anything starts
 * when either value is missing, and {@link NoBuildCommand} when there is nothing to run, or a bare
 * build is asked for from inside one.
 */
export async function runFrontendBuild(cwd: string, command: readonly string[], opts: FrontendBuildOptions = {}): Promise<number> {
  const processEnv = { ...process.env, ...opts.processEnv }
  const program = buildProgram(cwd, command, processEnv)
  const values = await resolveFrontendValues({
    cwd,
    env: opts.env,
    allowLocal: opts.allowLocal === true,
    processEnv,
  })
  info(`Building with the ${describeFrontendSources(values)}: ${program.describe}`)
  const env = { ...withProjectBins(processEnv, cwd), ...frontendEnv(values), [BUILD_ACTIVE_ENV]: "1" }
  return runBuildProcess(program, cwd, env)
}
