/**
 * Non-blocking update notification shown after CLI commands.
 * Checks once per 24 hours. Skips in CI environments.
 */

import { ENGINE_VERSION } from "../engine-version.js"
import {
  shouldCheckForUpdates,
  saveUpdateCheck,
  getLastKnownLatestVersion,
} from "./cache.js"
import { checkLatestVersion } from "./resolve.js"

/**
 * Show an update notification if a newer engine version is available.
 * This runs after every CLI command, but only actually checks the network
 * once per 24 hours (throttled via ~/.supatype/update-check.json).
 */
export async function showUpdateNotification(): Promise<void> {
  try {
    const shouldCheck = await shouldCheckForUpdates()

    if (shouldCheck) {
      // Perform network check
      const latest = await checkLatestVersion()
      if (latest) {
        await saveUpdateCheck(latest.version)
        if (latest.version !== ENGINE_VERSION) {
          printNotification(latest.version)
        }
      }
    } else {
      // Use cached info from last check
      const cachedLatest = await getLastKnownLatestVersion()
      if (cachedLatest && cachedLatest !== ENGINE_VERSION) {
        printNotification(cachedLatest)
      }
    }
  } catch {
    // Never fail the CLI command because of update check
  }
}

function printNotification(latestVersion: string): void {
  console.log()
  console.log(
    `Supatype engine v${latestVersion} is available. ` +
    `Run: npm update @supatype/cli`,
  )
}
