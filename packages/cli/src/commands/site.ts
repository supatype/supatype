/**
 * `supatype site env pull | list | set | unset [--env <name>]`: a static site's public values.
 *
 * They are the non-secret settings its pages read, set in `build.publicEnv` of supatype.config.ts or,
 * on Supatype Cloud, in Studio. The config wins a name both set, and Studio shows it read-only. Only
 * Cloud holds values Studio set, so `set` and `unset` are Cloud's; anywhere else the config's values
 * are all there are, and the config is where to change them.
 */

import type { Command } from "commander"
import { prefixedPublicEnv, publicEnvFor } from "@supatype/types"
import { loadConfig, mainConfigFile } from "../config.js"
import { upsertEnvFile } from "../env-file.js"
import { errorMessage } from "../error-message.js"
import { loadProjectLink } from "../link.js"
import { resolveTarget, type DeployTarget } from "../resolve-target.js"
import { deletePublicEnv, listPublicEnv, setPublicEnv, type PublicEnvEntry } from "../site-public-env.js"
import { fatalError } from "../ui/fatal.js"
import { info, plain, warn } from "../ui/messages.js"

/** What every `site env` command takes. */
export interface SiteEnvOptions {
  env?: string | undefined
}

export interface PullOptions extends SiteEnvOptions {
  /** Write the values the config sets as well. A build reads those from the config itself. */
  includeConfig?: boolean | undefined
}

/** The Cloud target the project is linked to, or undefined: no link, or a self-host or local one. */
function cloudTarget(cwd: string, env: string | undefined): DeployTarget | undefined {
  if (loadProjectLink(cwd) === null) return undefined
  const target = resolveTarget(cwd, { env })
  return target.mode === "cloud" ? target : undefined
}

/** `build.publicEnv` for `environment`, as entries. A folder with no config has none. */
function configEntries(cwd: string, environment: string): PublicEnvEntry[] {
  if (mainConfigFile(cwd) === undefined) return []
  const values = publicEnvFor(loadConfig(cwd).build?.publicEnv, environment)
  return Object.entries(values).map(([name, value]) => ({ name, value, source: "config" }))
}

/** The environment a project without a Cloud link answers for: `--env`, else the link's, else production. */
function environmentOf(cwd: string, env: string | undefined): string {
  if (env !== undefined) return env
  return loadProjectLink(cwd) === null ? "production" : resolveTarget(cwd, {}).environment
}

/** The values in effect for the environment, and the environment: Cloud's, else the config's. */
async function effective(cwd: string, opts: SiteEnvOptions): Promise<{ environment: string; entries: PublicEnvEntry[] }> {
  const target = cloudTarget(cwd, opts.env)
  if (target !== undefined) return { environment: target.environment, entries: await listPublicEnv(target) }
  const environment = environmentOf(cwd, opts.env)
  return { environment, entries: configEntries(cwd, environment) }
}

/** The values in effect for the environment, each with where it is set. */
export async function listSiteEnv(cwd: string, opts: SiteEnvOptions): Promise<PublicEnvEntry[]> {
  return (await effective(cwd, opts)).entries
}

const SOURCE_TEXT: Record<PublicEnvEntry["source"], string> = {
  config: "set in supatype.config.ts",
  studio: "set in Studio",
}

/** One aligned line per value: name, value, where it is set. */
export function siteEnvLines(entries: readonly PublicEnvEntry[]): string[] {
  const nameWidth = Math.max(0, ...entries.map((entry) => entry.name.length))
  const valueWidth = Math.max(0, ...entries.map((entry) => entry.value.length))
  return entries.map((entry) => `${entry.name.padEnd(nameWidth)}  ${entry.value.padEnd(valueWidth)}  ${SOURCE_TEXT[entry.source]}`)
}

/** The file a pull writes: `.env.<environment>.local`, with anything not fit for a file name made a dash. */
export function pullFileName(environment: string): string {
  return `.env.${environment.replace(/[^A-Za-z0-9_-]/g, "-")}.local`
}

/**
 * Write the values set in Studio, under every framework's prefix, into `.env.<environment>.local`,
 * which Vite, Next.js and Expo read for a build in that mode. The config's own are left out unless
 * asked for: a build reads them from the config, and a copy here would go stale. Names already in the
 * file are updated and the rest of it kept. No file is written when there is nothing to write.
 */
export async function pullSiteEnv(cwd: string, opts: PullOptions): Promise<{ file: string; names: string[] }> {
  const { environment, entries } = await effective(cwd, opts)
  const chosen = entries.filter((entry) => opts.includeConfig === true || entry.source !== "config")
  const file = pullFileName(environment)
  if (chosen.length === 0) return { file, names: [] }
  const values = prefixedPublicEnv(Object.fromEntries(chosen.map((entry) => [entry.name, entry.value])))
  upsertEnvFile(cwd, values, { file })
  return { file, names: chosen.map((entry) => entry.name).sort() }
}

function requireCloud(cwd: string, opts: SiteEnvOptions, verb: string): DeployTarget {
  const target = cloudTarget(cwd, opts.env)
  if (target === undefined) {
    throw new Error(
      `${verb} is for a project linked to Supatype Cloud. Anywhere else the public values are the ones in build.publicEnv of supatype.config.ts: change them there and run supatype push.`,
    )
  }
  return target
}

/** Set one value on the Cloud environment, as Studio would. Refused for a name the config sets. */
export async function setSiteEnv(cwd: string, name: string, value: string, opts: SiteEnvOptions): Promise<void> {
  await setPublicEnv(requireCloud(cwd, opts, "supatype site env set"), name, value)
}

/** Remove one value set on the Cloud environment. Refused for a name the config sets. */
export async function unsetSiteEnv(cwd: string, name: string, opts: SiteEnvOptions): Promise<void> {
  await deletePublicEnv(requireCloud(cwd, opts, "supatype site env unset"), name)
}

/** Runs `work`, ending the command with its error's message instead of a stack. */
async function reporting(work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (err) {
    fatalError(errorMessage(err))
  }
}

export function registerSite(program: Command): void {
  const site = program.command("site").description("Your static site")
  const env = site
    .command("env")
    .description("The site's public values: non-secret settings every visitor can read, set per environment")

  env
    .command("list")
    .description("List the values in effect, and where each is set")
    .option("--env <name>", "Environment (default: the link's default)")
    .action((opts: SiteEnvOptions) =>
      reporting(async () => {
        const entries = await listSiteEnv(process.cwd(), opts)
        if (entries.length === 0) info("No public values set.")
        else for (const line of siteEnvLines(entries)) plain(line)
      }),
    )

  env
    .command("pull")
    .description("Write the values set in Studio to .env.<env>.local under every framework's prefix")
    .option("--env <name>", "Environment (default: the link's default)")
    .option("--include-config", "Write the values supatype.config.ts sets too (a build reads those from the config)")
    .action((opts: PullOptions) =>
      reporting(async () => {
        const { file, names } = await pullSiteEnv(process.cwd(), opts)
        if (names.length === 0) warn("Nothing to pull: no value is set in Studio for this environment.")
        else info(`Wrote ${names.length} public value(s) to ${file}: ${names.join(", ")}`)
      }),
    )

  env
    .command("set <name> <value>")
    .description("Set a public value on Supatype Cloud. Every visitor can read it, so never a secret")
    .option("--env <name>", "Environment (default: the link's default)")
    .action((name: string, value: string, opts: SiteEnvOptions) =>
      reporting(async () => {
        await setSiteEnv(process.cwd(), name, value, opts)
        info(`Set ${name}.`)
      }),
    )

  env
    .command("unset <name>")
    .description("Remove a public value set on Supatype Cloud")
    .option("--env <name>", "Environment (default: the link's default)")
    .action((name: string, opts: SiteEnvOptions) =>
      reporting(async () => {
        await unsetSiteEnv(process.cwd(), name, opts)
        info(`Removed ${name}.`)
      }),
    )
}
