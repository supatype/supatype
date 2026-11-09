/**
 * self-host commands: manage self-hosted deployments, on Docker Compose.
 *
 * 0.9.2: the hidden `self-host native` group (systemd units, a foreground supatype-server) is
 * gone. It ran the server's built-in object store, which applies no storage read rules.
 */

import { Command } from "commander"
import { errorMessage } from "../error-message.js"
import { existsSync } from "node:fs"
import { loadConfig, loadSchemaAst } from "../config.js"
import { schemaPathFromProject, type SupatypeProjectConfig } from "../project-config.js"
import { composeKongHostPort } from "../local-gateway.js"
import { withPublishing } from "../model-versioning.js"
import { devApiKeys } from "../dev-api-keys.js"
import { fillMissingKeys } from "./keys.js"
import { requireUrlSafeComposePasswords } from "../url-safe-passwords.js"
import {
  composeProjectName,
  exitComposeFailed,
  noteUnpinnedImages,
  runDockerCompose,
  runDockerComposeQuietly,
  selfHostComposePaths,
  writeSelfHostCompose,
} from "../self-host-compose.js"
import { composeRenderOptions } from "../compose-render-mode.js"
import { warnBucketsLeft } from "../storage-provision.js"
import { syncConfigMailerEnv } from "../config-mailer-env.js"
import { takenComposePorts, type ComposeContext, type PublishedPort } from "../compose-services.js"
import { isPortInUse, portCheckCommand } from "../postgres-ctl.js"
import { retireCliMailerAutoconfirm } from "../mailer-autoconfirm.js"
import { fatalError } from "../ui/fatal.js"
import { warnIfHandWrittenUrlSilent } from "../database-url-owner.js"
import { warnMissingStackSettings } from "../stack-setting-warnings.js"
import { file, error, info, plain, warn } from "../ui/messages.js"
import { confirm } from "../ui/confirm.js"
import { isInteractive } from "../ui/interactive.js"
import { withSpinner } from "../ui/progress.js"

export function registerSelfHost(program: Command): void {
  const selfHostCmd = program
    .command("self-host")
    .description("Manage self-hosted deployments (Docker Compose only)")

  const composeCmd = selfHostCmd
    .command("compose")
    .description("Manage compose-based self-host runtime")

  composeCmd
    .command("render")
    .description("Render deterministic self-host compose artifacts")
    .action(() => {
      const cwd = process.cwd()
      const config = loadConfig(cwd, { local: false })
      requireUrlSafeComposePasswords(cwd, config)
      warnMissingStackSettings(cwd, config)
      const out = writeSelfHostCompose(cwd, config, composeRenderOptions(cwd, config.project.name))
      file("wrote", out.composePath)
      file("wrote", out.kongPath)
    })

  composeCmd
    .command("up")
    .description("Render and start compose services")
    .option("-d, --detach", "Start in detached mode", true)
    .action(async (opts: { detach?: boolean }) => {
      const cwd = process.cwd()
      const config = loadConfig(cwd, { local: false })
      const project = composeProjectName(config.project.name)
      const args = opts.detach ? ["up", "-d"] : ["up"]
      // Before anything is written into .env, as the key and secret checks below are.
      requireUrlSafeComposePasswords(cwd, config)
      // A .env copied from the template arrives with both keys blank, and the
      // server will not serve without a service role key outside dev mode.
      // Only blanks are filled: reissuing a key an operator is already using
      // would lock out every client holding the old one. The secret is checked
      // inside, before anything is written, since only PostgREST would notice a
      // short one.
      const { filled, note, warning } = fillMissingKeys(cwd)
      if (warning !== undefined) console.warn(`[supatype] ${warning}`)
      if (note !== undefined) console.log(`[supatype] ${note}`)
      if (filled.length > 0) {
        console.log(`[supatype] Minted ${filled.join(" and ")} in .env from JWT_SECRET.`)
      }
      // The committed config's mailer values, over any the last `dev` wrote from its local one, once the
      // SUPATYPE_MAILER_AUTOCONFIRM an earlier CLI wrote is out of the way (FF7).
      retireCliMailerAutoconfirm(cwd)
      syncConfigMailerEnv(cwd, config)
      // Before the spinner, so the warnings are not drawn over.
      warnMissingStackSettings(cwd, config)
      noteUnpinnedImages(cwd)
      const renderOptions = composeRenderOptions(cwd, config.project.name)
      // DATABASE_URL in .env is not moved to this stack's port. That line is dev's, and moving it
      // here had dev and self-host rewriting it in turn (issue 26). Host commands such as seed and
      // admin reach the running stack's port past a URL the CLI wrote (host-database.ts).
      const out = writeSelfHostCompose(cwd, config, renderOptions)
      await requireComposePortsFree({ composePath: out.composePath, projectRoot: cwd, projectName: project })
      // In a terminal, quietly and without blocking, as `dev` starts its stack: docker's progress
      // stays out of the CLI's screen (runDockerCompose says why) and the spinner turns through
      // the pulls. Its output is kept for a failure.
      const status = await withSpinner("Starting self-host Compose stack", async () =>
        isInteractive()
          ? runDockerComposeQuietly(out.composePath, args, cwd, project, SELF_HOST_BRAND)
          : runDockerCompose(out.composePath, args, cwd, project, { brand: SELF_HOST_BRAND }),
      )
      if (status !== 0) {
        exitComposeFailed(status, "Could not start the self-host Compose stack.", SELF_HOST_BRAND)
      }
      // Attached, `up` returns only once the stack has stopped, so there is nothing to provision.
      if (opts.detach === true) await provisionAfterUp(cwd, config, project, renderOptions.devLocal)
      await warnIfHandWrittenUrlSilent(cwd)
    })

  composeCmd
    .command("down")
    .description("Stop compose services (volumes are kept unless --volumes)")
    .option("--volumes", "Also remove the stack's volumes: the database and stored files")
    .option("-y, --yes", "Remove the volumes without asking")
    .action(composeDown)

  // Recreated rather than `docker compose restart`, which keeps the container as it was created:
  // a changed .env or config would not reach it, and that is what a restart is usually for.
  // Through `up`, so a Kong in front of a recreated service is reloaded onto its new address.
  composeCmd
    .command("restart <service>")
    .description("Recreate one service with the current config and .env, leaving the others running")
    .action((service: string) => {
      const status = renderAndRunCompose(["up", "-d", "--force-recreate", "--no-deps", service])
      if (status !== 0) {
        exitComposeFailed(status, `Could not restart ${service}.`, SELF_HOST_BRAND)
      }
    })

  composeCmd
    .command("status")
    .description("Show compose service status")
    .action(() => {
      process.exitCode = runAgainstStack(["ps"])
    })

  composeCmd
    .command("logs")
    .description("Tail compose logs")
    .option("--service <name>", "Filter to one service")
    .option("-f, --follow", "Follow log output", true)
    .action((opts: { service?: string; follow?: boolean }) => {
      const args = ["logs"]
      if (opts.follow) args.push("-f")
      if (opts.service) args.push(opts.service)
      process.exitCode = runAgainstStack(args)
    })
}

const SELF_HOST_BRAND = { intro: "Self-host deployment" }

/**
 * The schema's declared buckets and the first admin user, on the stack `up` has just started, once
 * it answers (issue 41): as `dev` and a push to a running stack do, so nothing waits on a push to
 * start the stack and make them. A failure to make them is warned about. A stack that never answers
 * through its gateway is not up, and says so with exit 1 (issue 57).
 */
async function provisionAfterUp(cwd: string, config: SupatypeProjectConfig, project: string, devLocal: boolean): Promise<void> {
  const { composeGatewayHostPort, provisionStartedStack, StackNotServing } = await import("../dev-compose.js")
  try {
    const gatewayPort = composeGatewayHostPort(config, devLocal ? "dev" : "standalone", composeKongHostPort(cwd))
    const ast = withPublishing(loadSchemaAst(schemaPathFromProject(config, cwd), cwd), config)
    const stack = { composePath: selfHostComposePaths(cwd).composePath, project, gatewayPort }
    warnBucketsLeft(await provisionStartedStack(cwd, config, stack, ast, devApiKeys(cwd).serviceRoleKey))
  } catch (err) {
    if (!(err instanceof StackNotServing)) {
      warn(`The stack is up, but its storage buckets or first admin user could not be created: ${errorMessage(err)}`)
      return
    }
    // Containers that started but never answered are not a stack that is up (issue 57).
    error(`The stack started but is not serving: ${errorMessage(err)}`)
    plain("Check: supatype self-host compose logs. A container left with no network by a failed start")
    plain("comes back with: supatype self-host compose restart <service>")
    process.exitCode = 1
  }
}

/**
 * Refuse `up` before it starts anything when a port the stack publishes is held by something else.
 * Docker otherwise starts some containers, fails on the port, and leaves them for the next `up`,
 * which the run behind issue 57 found with no network at all.
 */
async function requireComposePortsFree(ctx: ComposeContext): Promise<void> {
  // A check that cannot read the compose file stops nothing: `up` itself says what is wrong with it.
  const taken = await takenComposePorts(ctx, isPortInUse).catch((): PublishedPort[] => [])
  const first = taken[0]
  if (first === undefined) return
  fatalError(
    `Port ${first.port} is already in use, and the stack's ${first.service} service publishes it.`,
    [
      ...taken.slice(1).map((t) => `Port ${t.port} (${t.service}) is in use too.`),
      `Check: ${portCheckCommand(first.port)}`,
      "Stop what holds it (another Supatype stack's `supatype dev` or compose stack, say), then run this again.",
    ],
    { brand: SELF_HOST_BRAND },
  )
}

/**
 * `self-host compose down`. The volumes hold the database and every stored file, so removing them
 * is asked for by name and confirmed; a plain `down` says they were kept, since starting over used
 * to mean finding them with `docker volume ls`.
 */
async function composeDown(opts: { volumes?: boolean; yes?: boolean }): Promise<void> {
  if (opts.volumes === true && opts.yes !== true && !(await confirmVolumeRemoval())) {
    plain("Nothing stopped and nothing removed.")
    return
  }
  const status = runAgainstStack(opts.volumes === true ? ["down", "--volumes"] : ["down"])
  if (status !== 0) {
    exitComposeFailed(status, "Could not stop the self-host Compose stack.", SELF_HOST_BRAND)
  }
  info(
    opts.volumes === true
      ? "Stopped the stack and removed its volumes: the database and stored files are gone."
      : "Stopped the stack. Its volumes (the database and stored files) were kept; " +
          "`supatype self-host compose down --volumes` removes them.",
  )
}

/** Asked, never assumed: without a terminal to ask on, `--yes` is the only way through. */
async function confirmVolumeRemoval(): Promise<boolean> {
  if (!isInteractive()) {
    error("Removing the volumes deletes the database and stored files. Pass --yes to confirm.")
    process.exitCode = 1
    return false
  }
  return confirm("Remove the volumes too? This deletes the database and every stored file.", {
    default: false,
  })
}

/**
 * Render the compose file from the current config, then run `args` against this project's stack.
 * Rendered first, so a container it creates never gets a stale host path or a config that changed.
 */
function renderAndRunCompose(args: string[]): number {
  return runCompose(args, "start")
}

/**
 * Run `args` against the compose file the running stack was started from, for the commands that
 * stop or inspect it. Not rewritten from the current config first: that would hold them to the
 * checks a new stack needs, so a stack started by an older CLI with a password this one refuses
 * could not be stopped, and it could name services the running stack does not have. Rendered only
 * when there is no file on disk yet.
 */
function runAgainstStack(args: string[]): number {
  return runCompose(args, existsSync(selfHostComposePaths(process.cwd()).composePath) ? "on-disk" : "render")
}

/**
 * Which compose file a command runs against: rendered to start or recreate containers, which is
 * when a URL-unsafe password is refused; rendered only because there is none yet; or the one on disk.
 */
type ComposeFileUse = "start" | "render" | "on-disk"

function runCompose(args: string[], use: ComposeFileUse): number {
  const cwd = process.cwd()
  // The committed config, not the developer's local override: this is the self-host stack (issue 24).
  const config = loadConfig(cwd, { local: false })
  if (use === "start") {
    requireUrlSafeComposePasswords(cwd, config)
    retireCliMailerAutoconfirm(cwd)
    syncConfigMailerEnv(cwd, config)
  }
  const composePath =
    use === "on-disk"
      ? selfHostComposePaths(cwd).composePath
      : writeSelfHostCompose(cwd, config, composeRenderOptions(cwd, config.project.name)).composePath
  return runDockerCompose(composePath, args, cwd, composeProjectName(config.project.name), {
    brand: SELF_HOST_BRAND,
  })
}
