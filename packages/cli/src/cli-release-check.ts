/**
 * Whether a newer CLI release exists, for `supatype update`.
 *
 * A Docker project's image pins are baked into the CLI that renders its compose file, so `update`
 * can only move them as far as the running CLI knows. Saying so when a newer release exists is what
 * lets a user on an old CLI find out why they are not getting newer images.
 */

import { cliPackageVersion } from "./cli-package-version.js"
import { EMBEDDED_CLI_VERSION } from "./cli-version-embedded.js"
import { detectCliInstallMethod, type CliInstallMethod } from "./cli-install-method.js"
import { fetchStandaloneCliLatestVersion } from "./cli-standalone.js"
import { errorMessage } from "./error-message.js"
import { compareVersions } from "./engine-floor.js"
import { info, plain, warn } from "./ui/messages.js"

/** What looking up the latest CLI release found. */
export type CliReleaseStatus =
  | { kind: "newer"; running: string; latest: string }
  | { kind: "current"; running: string; latest: string }
  | { kind: "unchecked"; running: string; reason: string }
  | { kind: "source-build" }

/** The command that upgrades a CLI installed the way `method` says, one line each. */
export function upgradeCommands(method: CliInstallMethod): string[] {
  switch (method) {
    case "npm":
      return ["npm update -g @supatype/cli"]
    case "homebrew":
      return ["brew update && brew upgrade supatype"]
    case "standalone":
      return ["supatype self-update", "or re-run the installer: curl -fsSL https://supatype.com/install.sh | bash"]
  }
}

/**
 * Look the latest release up and compare it with the running CLI. A lookup that fails is a status,
 * not an error: an offline machine must still be able to update.
 */
export async function checkCliRelease(): Promise<CliReleaseStatus> {
  // A source build stamps no version, and its package.json version says nothing about a release.
  if (EMBEDDED_CLI_VERSION === "") return { kind: "source-build" }
  const running = cliPackageVersion()
  try {
    const latest = await fetchStandaloneCliLatestVersion()
    return compareVersions(running, latest) < 0 ? { kind: "newer", running, latest } : { kind: "current", running, latest }
  } catch (err) {
    return { kind: "unchecked", running, reason: errorMessage(err) }
  }
}

/** Say what the lookup found: a newer release and how to get it, or that the pins are current. */
export function reportCliRelease(status: CliReleaseStatus, check: boolean): void {
  switch (status.kind) {
    case "source-build":
      info("Skipping the CLI release check: this CLI was built from source and has no release version.")
      return
    case "unchecked":
      warn(`Could not check for a newer CLI release (${status.reason}). Carrying on with the pins in v${status.running}.`)
      if (check) plain(`Running CLI: v${status.running}`)
      return
    case "current":
      if (check) {
        plain(`Running CLI: v${status.running}`)
        plain(`Latest CLI release: v${status.latest}`)
      }
      info(`The image pins are current for v${status.running}, the latest CLI release.`)
      return
    case "newer":
      reportNewer(status.running, status.latest, check)
      return
  }
}

function reportNewer(running: string, latest: string, check: boolean): void {
  if (check) {
    plain(`Running CLI: v${running}`)
    plain(`Latest CLI release: v${latest}`)
  }
  info(`A newer release exists: supatype CLI v${latest} (this is v${running}).`)
  plain("  The image pins come from the CLI version, so upgrade the CLI first to get newer images:")
  for (const command of upgradeCommands(detectCliInstallMethod())) plain(`    ${command}`)
  plain(
    check
      ? `  Upgrading the CLI would move the image pins; \`supatype update\` with this CLI pulls the pins of v${running}.`
      : `  Carrying on with the pins of v${running}.`,
  )
}
