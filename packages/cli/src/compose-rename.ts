/**
 * Detect and clean up Docker Compose state when `project.name` changes.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { loadLocalEnvironment } from "./link.js"
import { composeStackHasContainers } from "./dev-session-lock.js"
import { composeProjectName, runDockerCompose, type SelfHostComposePaths } from "./self-host-compose.js"
import { confirm as uiConfirm } from "./ui/confirm.js"
import { isInteractive } from "./ui/interactive.js"
import { success, warn } from "./ui/messages.js"

/**
 * When `project.name` changes, the compose project slug changes too (`supatype-{name}`).
 * Offer to stop containers from the previous slug so volumes/ports do not linger.
 */
export async function handleComposeProjectRename(
  cwd: string,
  currentProjectName: string,
  paths: SelfHostComposePaths,
): Promise<void> {
  const local = loadLocalEnvironment(cwd)
  const previousRef = local?.projectRef?.trim()
  if (!previousRef || previousRef === currentProjectName) return

  const previousCompose = composeProjectName(previousRef)
  const currentCompose = composeProjectName(currentProjectName)
  if (previousCompose === currentCompose) return
  if (!composeStackHasContainers(previousCompose)) return

  const message =
    `Project renamed from "${previousRef}" to "${currentProjectName}".\n` +
    `Docker stack "${previousCompose}" may still be running.`

  if (!isInteractive()) {
    warn(message)
    warn(`Stop it manually: docker compose -p ${previousCompose} down`)
    return
  }

  const stopOld = await uiConfirm(`${message}\n\nStop the old Docker stack now?`, { default: true })

  if (!stopOld) {
    warn(`Leaving "${previousCompose}" running. Stop it with: docker compose -p ${previousCompose} down`)
    return
  }

  const status = runDockerCompose(paths.composePath, ["down"], cwd, previousCompose, { quiet: true })
  if (status === 0) {
    success(`Stopped old stack "${previousCompose}".`)
    warnIfHardcodedComposeScripts(cwd, previousCompose)
  } else {
    warn(`Could not stop "${previousCompose}" (exit ${status}). Try: docker compose -p ${previousCompose} down`)
  }
}

function warnIfHardcodedComposeScripts(cwd: string, oldComposeProject: string): void {
  const pkgPath = join(cwd, "package.json")
  if (!existsSync(pkgPath)) return
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> }
    const scripts = Object.values(pkg.scripts ?? {}).join("\n")
    if (scripts.includes(`-p ${oldComposeProject}`)) {
      warn(
        `package.json scripts still reference compose project "${oldComposeProject}". ` +
          "Update them if you renamed project.name in supatype.config.ts.",
      )
    }
  } catch {
    // ignore invalid package.json
  }
}
