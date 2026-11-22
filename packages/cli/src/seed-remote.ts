/**
 * `supatype seed` against a linked project: Supatype Cloud, or a self-hosted server linked with
 * `supatype link`. The files are collected here, exactly as for the engine on this machine, and the
 * control plane applies them with its own engine as the environment's role. The CLI never holds a
 * database credential for it.
 *
 * Everything that can be refused is refused before anything is sent: a production seed that was not
 * confirmed, an `--environment` that disagrees with the target, a server that cannot seed, a file
 * with no default export (which would run its writes when imported).
 */

import { formatRemoteSeedRefusal, isRemoteSeedRefusal, type RemoteSeedRequest } from "@supatype/types"
import type { SeedFlags } from "./commands/seed.js"
import { loadSchemaAst, type SupatypeConfig } from "./config.js"
import { seedUnsupportedByPinnedEngine } from "./engine-floor.js"
import { errorMessage } from "./error-message.js"
import { loadProjectLink } from "./link.js"
import { schemaPathFromProject } from "./project-config.js"
import { pushAuditFields } from "./push-audit.js"
import {
  loadBranchContext,
  resolveTarget,
  targetProjectRef,
  targetSeed,
  targetSeedCapabilities,
  targetSeedStatus,
  type DeployTarget,
} from "./resolve-target.js"
import { defaultExportOf } from "./seed-default-export.js"
import {
  collectPrepared,
  existingSeedPaths,
  locateBuilder,
  runOnceForAll,
  seedDocuments,
  seedLabel,
  type Prepared,
} from "./seed-prepare.js"
import { isSeedResult, isSeedStatus, report, reportSeedStatus } from "./seed-report.js"
import { isInteractive } from "./ui/interactive.js"
import { TargetApiError } from "./target-client.js"
import { promptText } from "./ui/prompts.js"
import { error } from "./ui/messages.js"

/**
 * The control plane this directory's link points at, or undefined when the seed belongs to the
 * engine here: no link, a link to a local stack, or a branch deploy context.
 */
export function linkedTarget(cwd: string, env: string | undefined): DeployTarget | undefined {
  if (loadProjectLink(cwd) === null || loadBranchContext(cwd) !== null) return undefined
  const target = resolveTarget(cwd, { env })
  return target.mode === "cloud" || target.mode === "self-host" ? target : undefined
}

/** What the target is called in a report and in the confirmation: `<ref> (<environment>)`. */
function describe(target: DeployTarget): string {
  return `${target.projectRef} (${target.environment})`
}

/** Apply (or, with `--status`, report) the project's seeds through `target`. The exit code. */
export async function runRemoteSeed(
  file: string | undefined,
  opts: SeedFlags,
  target: DeployTarget,
  config: SupatypeConfig,
): Promise<number> {
  const refused = refuseFlags(opts, target)
  if (refused) return 2
  // Status asks the server directly: capabilities need the push permission, status only the view one.
  if (opts.status) return await remoteStatus(target)
  const unfit = await refuseUnfitServer(target)
  if (unfit) return 2
  return await remoteApply(file, opts, target, config)
}

/** `--force` and a contradicting `--environment`: both are mistakes a script would not notice. */
function refuseFlags(opts: SeedFlags, target: DeployTarget): boolean {
  if (opts.force) {
    error(
      `--force no longer applies to a project linked to ${target.mode === "cloud" ? "Supatype Cloud" : "a Supatype server"}.\n` +
        "  To seed production without a prompt, pass --confirm-production.\n" +
        "  To seed the local stack instead, pass --local.",
    )
    return true
  }
  if (opts.environment !== undefined && opts.environment !== target.environment) {
    error(
      `--environment ${opts.environment} does not match the target environment ${target.environment}.\n` +
        "  A seed's `environment` condition is the environment it is sent to: drop --environment, " +
        `or pass --env ${opts.environment} to seed that environment.`,
    )
    return true
  }
  return false
}

/** A server that does not list the seed feature, or whose engine is too old to seed. */
async function refuseUnfitServer(target: DeployTarget): Promise<boolean> {
  try {
    const caps = await targetSeedCapabilities(target)
    const tooOld = seedUnsupportedByPinnedEngine(caps.version)
    if (tooOld === undefined) return false
    error(tooOld)
  } catch (e) {
    error(errorMessage(e))
  }
  return true
}

async function remoteStatus(target: DeployTarget): Promise<number> {
  try {
    return reportSeedStatus(await targetSeedStatus(target, isSeedStatus), describe(target))
  } catch (e) {
    error(errorMessage(e))
    return 2
  }
}

async function remoteApply(
  file: string | undefined,
  opts: SeedFlags,
  target: DeployTarget,
  config: SupatypeConfig,
): Promise<number> {
  const cwd = process.cwd()
  const paths = existingSeedPaths(file, cwd, config)
  if (paths === undefined) return 2
  if (refuseWithoutDefaultExport(paths, cwd)) return 2
  const builderPath = locateBuilder(cwd, config)
  if (builderPath === undefined) return 2

  const collection = collectPrepared(paths, { cwd, builderPath, environment: target.environment })
  if ("failed" in collection) return collection.failed
  if (collection.legacy.length > 0) return refuseLegacy(collection.legacy)

  const request = requestFor(collection.prepared, opts, target, config, cwd)
  if (request === undefined) return 1
  if (!(await productionConfirmed(target, opts))) return 2
  return await send(target, request, collection.prepared.length)
}

/**
 * Decision D10: a file is checked for a default export by reading it, before anything imports it.
 * A file that cannot be read as TypeScript is refused as well: importing it to find out is what
 * this check exists to avoid.
 */
function refuseWithoutDefaultExport(paths: readonly string[], cwd: string): boolean {
  const verdicts = paths.map((path) => ({ label: seedLabel(cwd, path), verdict: defaultExportOf(path) }))
  const bad = verdicts.filter((one) => one.verdict !== "present")
  if (bad.length === 0) return false
  error(
    "A seed sent to a linked project must export a default function. These files cannot be sent, " +
      "because a file without one runs its writes when it is imported:\n" +
      bad.map((one) => `  ${one.label}${one.verdict === "unknown" ? " (could not be read as TypeScript)" : ""}`).join("\n") +
      "\n  Export a default function, as in `export default async ({ db }) => { ... }`, " +
      "or seed the local stack with --local.",
  )
  return true
}

/** The files the collector found without a default export after the check said they had one. */
function refuseLegacy(labels: readonly string[]): number {
  error(
    "These seed files have no default export, so they ran when they were read and cannot be sent:\n" +
      labels.map((label) => `  ${label}`).join("\n"),
  )
  return 2
}

/** The request for `prepared`, or undefined after reporting a document that could not be made. */
function requestFor(
  prepared: readonly Prepared[],
  opts: SeedFlags,
  target: DeployTarget,
  config: SupatypeConfig,
  cwd: string,
): RemoteSeedRequest | undefined {
  try {
    const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)
    return {
      ast,
      irDocuments: seedDocuments(prepared, ast),
      atomic: opts.atomic,
      runOnce: runOnceForAll(prepared),
      environment: target.environment,
      // True only for production, and only reached once the gate has passed.
      confirmProduction: target.environment === "production",
      pushedFrom: pushAuditFields(cwd).pushed_from,
    }
  } catch (e) {
    error(errorMessage(e))
    return undefined
  }
}

/**
 * The production gate. Interactive: type the project ref. Otherwise only the flag confirms. The
 * server checks `confirmProduction` too, so a hand-rolled client cannot skip it.
 */
async function productionConfirmed(target: DeployTarget, opts: SeedFlags): Promise<boolean> {
  if (target.environment !== "production" || opts.confirmProduction === true) return true
  if (!isInteractive()) {
    error(
      `Seeding production (${target.projectRef}) needs confirmation. ` +
        "Pass --confirm-production to run it without a prompt.",
    )
    return false
  }
  // Cloud's link holds the slug; the ref is what the dashboard and the API call the project.
  const ref = (await targetProjectRef(target)) ?? target.projectRef
  const typed = await promptText(`This seeds production in ${ref}. Type the project ref, ${ref}, to continue`)
  if (typed.trim() === ref || typed.trim() === target.projectRef) return true
  error(`That is not the project ref (${ref}), so nothing was seeded.`)
  return false
}

/**
 * A failed request as the CLI prints it. A seed refusal carries its code beside its message, and the
 * code is what a script or a bug report quotes, so it leads: `[seed_busy] Another seed is ...`.
 */
function failureText(e: unknown): string {
  if (!(e instanceof TargetApiError)) return errorMessage(e)
  const said = e.details?.["message"]
  const code = e.details?.["error"]
  if (!isRemoteSeedRefusal(code) || typeof said !== "string") return errorMessage(e)
  return formatRemoteSeedRefusal(code, said)
}

async function send(target: DeployTarget, request: RemoteSeedRequest, count: number): Promise<number> {
  try {
    return report(await targetSeed(target, request, isSeedResult), count, describe(target))
  } catch (e) {
    // A refusal or a server failure is the run not starting, whatever its status.
    error(failureText(e))
    return 2
  }
}
