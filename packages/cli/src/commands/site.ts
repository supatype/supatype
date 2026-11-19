/**
 * `supatype site env pull | list | set | unset [--env <name>]`: a static site's public values.
 *
 * They are the non-secret settings its pages read, set in `build.publicEnv` of supatype.config.ts or,
 * on Supatype Cloud, in Studio. The config wins a name both set, and Studio shows it read-only. Only
 * Cloud holds values Studio set, so `set` and `unset` are Cloud's; anywhere else the config's values
 * are all there are, and the config is where to change them.
 *
 * A failure is thrown, and the CLI's top level prints it and exits 1.
 */

import type { Command } from "commander"
import { PUBLIC_ENV_SOURCE_LABELS, prefixedPublicEnv, type PublicEnvEntry } from "@supatype/types"
import { upsertEnvFile } from "../env-file.js"
import {
  deletePublicEnv,
  listPublicEnv,
  publicValueCount,
  setPublicEnv,
  siteScope,
  type SiteScope,
} from "../site-public-env.js"
import { info, plain, warn } from "../ui/messages.js"

/** What every `site env` command takes. */
export interface SiteEnvOptions {
  env?: string | undefined
}

export interface PullOptions extends SiteEnvOptions {
  /** Write the values the config sets as well. A build reads those from the config itself. */
  includeConfig?: boolean | undefined
}

/** The values in effect for the scope's environment: Cloud's, else the config's. */
async function effective(scope: SiteScope): Promise<PublicEnvEntry[]> {
  if (scope.cloud !== undefined) return listPublicEnv(scope.cloud)
  return Object.entries(scope.config).map(([name, value]) => ({ name, value, source: "config" }))
}

/** The values in effect for the environment, each with where it is set. */
export async function listSiteEnv(cwd: string, opts: SiteEnvOptions): Promise<PublicEnvEntry[]> {
  return effective(siteScope(cwd, opts))
}

/** One aligned line per value: name, value, where it is set. */
export function siteEnvLines(entries: readonly PublicEnvEntry[]): string[] {
  const nameWidth = Math.max(0, ...entries.map((entry) => entry.name.length))
  const valueWidth = Math.max(0, ...entries.map((entry) => entry.value.length))
  return entries.map((entry) => `${entry.name.padEnd(nameWidth)}  ${entry.value.padEnd(valueWidth)}  ${PUBLIC_ENV_SOURCE_LABELS[entry.source]}`)
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
  const scope = siteScope(cwd, opts)
  const chosen = (await effective(scope)).filter((entry) => opts.includeConfig === true || entry.source !== "config")
  const file = pullFileName(scope.environment)
  if (chosen.length === 0) return { file, names: [] }
  upsertEnvFile(cwd, prefixedPublicEnv(Object.fromEntries(chosen.map((entry) => [entry.name, entry.value]))), { file })
  return { file, names: chosen.map((entry) => entry.name).sort() }
}

function requireCloud(cwd: string, opts: SiteEnvOptions, verb: string): NonNullable<SiteScope["cloud"]> {
  const { cloud } = siteScope(cwd, opts)
  if (cloud === undefined) {
    throw new Error(
      `${verb} is for a project linked to Supatype Cloud. Anywhere else the public values are the ones in build.publicEnv of supatype.config.ts: change them there and run supatype push.`,
    )
  }
  return cloud
}

/** Set one value on the Cloud environment, as Studio would. Refused for a name the config sets. */
export async function setSiteEnv(cwd: string, name: string, value: string, opts: SiteEnvOptions): Promise<void> {
  await setPublicEnv(requireCloud(cwd, opts, "supatype site env set"), name, value)
}

/** Remove one value set on the Cloud environment. Refused for a name the config sets. */
export async function unsetSiteEnv(cwd: string, name: string, opts: SiteEnvOptions): Promise<void> {
  await deletePublicEnv(requireCloud(cwd, opts, "supatype site env unset"), name)
}

/** Adds the `--env` option every `site env` command takes. */
function withEnv(command: Command): Command {
  return command.option("--env <name>", "Environment (default: the link's default)")
}

export function registerSite(program: Command): void {
  const site = program.command("site").description("Your static site")
  const env = site
    .command("env")
    .description("The site's public values: non-secret settings every visitor can read, set per environment")

  withEnv(env.command("list").description("List the values in effect, and where each is set")).action(async (opts: SiteEnvOptions) => {
    const entries = await listSiteEnv(process.cwd(), opts)
    if (entries.length === 0) info("No public values set.")
    else for (const line of siteEnvLines(entries)) plain(line)
  })

  withEnv(env.command("pull").description("Write the values set in Studio to .env.<env>.local under every framework's prefix"))
    .option("--include-config", "Write the values supatype.config.ts sets too (a build reads those from the config)")
    .action(async (opts: PullOptions) => {
      const { file, names } = await pullSiteEnv(process.cwd(), opts)
      if (names.length === 0) warn("Nothing to pull: no value is set in Studio for this environment.")
      else info(`Wrote ${publicValueCount(names.length)} to ${file}: ${names.join(", ")}`)
    })

  withEnv(env.command("set <name> <value>").description("Set a public value on Supatype Cloud. Every visitor can read it, so never a secret")).action(
    async (name: string, value: string, opts: SiteEnvOptions) => {
      await setSiteEnv(process.cwd(), name, value, opts)
      info(`Set ${name}.`)
    },
  )

  withEnv(env.command("unset <name>").description("Remove a public value set on Supatype Cloud")).action(async (name: string, opts: SiteEnvOptions) => {
    await unsetSiteEnv(process.cwd(), name, opts)
    info(`Removed ${name}.`)
  })
}
