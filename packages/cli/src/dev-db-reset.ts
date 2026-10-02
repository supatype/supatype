/**
 * `supatype dev --reset-db`: start again from an empty local database, on request only.
 *
 * The one place `dev` removes data, and it removes exactly one volume. Storage and the cache keep
 * the developer's uploaded files and warm keys, and nothing about a database reset is a reason to
 * lose those, which is what `docker compose down -v` used to do whenever a push failed.
 *
 * Confirmed by a prompt that names the volume. With no TTY there is nobody to answer it, so the
 * flag is refused unless `--yes` says the caller has already decided.
 */
import { spawnSync } from "node:child_process"
import type { DockerBrandOptions } from "./docker-runtime.js"
import { DB_VOLUME_KEY, exitComposeFailed, runDockerCompose } from "./self-host-compose.js"
import { confirm } from "./ui/confirm.js"
import { fatalError } from "./ui/fatal.js"
import { isInteractive } from "./ui/interactive.js"

export interface DevDbResetTarget {
  composePath: string
  cwd: string
  /** The compose project name, which Docker prefixes every volume with. */
  project: string
  /** True when the project points at a database Supatype does not run. */
  external: boolean
  brand?: DockerBrandOptions
  /** Runs before any exit, so the message reaches the terminal rather than the dev TUI. */
  onFailure?: () => void
}

/** The Docker volume holding this project's Postgres data. */
export function devDbVolumeName(composeProject: string): string {
  return `${composeProject}_${DB_VOLUME_KEY}`
}

function brandOpts(target: DevDbResetTarget): { brand?: DockerBrandOptions } {
  return target.brand !== undefined ? { brand: target.brand } : {}
}

function fail(target: DevDbResetTarget, message: string, hints: string[]): never {
  target.onFailure?.()
  fatalError(message, hints, brandOpts(target))
}

function volumeExists(volume: string): boolean {
  return spawnSync("docker", ["volume", "inspect", volume], { encoding: "utf8" }).status === 0
}

/** Returns once the developer has agreed to lose the volume, and exits otherwise. */
async function requireApproval(target: DevDbResetTarget, volume: string, yes: boolean): Promise<void> {
  if (yes) return
  if (!isInteractive()) {
    fail(target, `--reset-db would remove the Postgres data volume ${volume}, and there is no terminal to confirm it.`, [
      "Re-run with --yes to remove it without a prompt. Nothing was removed.",
    ])
  }
  const approved = await confirm(
    `Remove the Postgres data volume ${volume}? Every row in the local database is deleted. Storage and other volumes are kept.`,
    { default: false },
  )
  if (!approved) fail(target, "Reset cancelled. Nothing was removed.", [])
}

function removeDbVolume(target: DevDbResetTarget, volume: string): void {
  // The volume cannot be removed while a container holds it, so the db container goes first, and
  // alone. No `-v` anywhere: the one volume that goes is named explicitly below.
  const rm = runDockerCompose(target.composePath, ["rm", "--stop", "--force", "db"], target.cwd, target.project, {
    quiet: true,
    ...brandOpts(target),
  })
  if (rm !== 0) {
    target.onFailure?.()
    exitComposeFailed(rm, "Could not stop the Postgres container. Nothing was removed.", target.brand)
  }
  const removed = spawnSync("docker", ["volume", "rm", volume], { encoding: "utf8" })
  if (removed.status !== 0) {
    fail(target, `Could not remove the Postgres data volume ${volume}.`, [String(removed.stderr ?? "").trim()])
  }
}

/** Remove the Postgres data volume, and nothing else, once the developer has agreed to it. */
export async function resetDevDatabase(target: DevDbResetTarget, opts: { yes: boolean }): Promise<void> {
  if (target.external) {
    fail(target, "--reset-db only resets a database Supatype runs.", [
      "This project points at an external database (database.external). Nothing was removed.",
    ])
  }
  const volume = devDbVolumeName(target.project)
  if (!volumeExists(volume)) {
    console.log(`[supatype] No Postgres data volume ${volume} yet, nothing to reset.`)
    return
  }
  await requireApproval(target, volume, opts.yes)
  removeDbVolume(target, volume)
  console.log(`[supatype] Removed the Postgres data volume ${volume}. Postgres starts empty.`)
}
