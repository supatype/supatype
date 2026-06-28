/**
 * Which CDN-cached host binaries a project needs (native vs docker).
 *
 * Docker runs Postgres, API, and schema push in Compose, but the CLI still uses a
 * host engine binary for type generation and admin-config refresh after push.
 */

import { existsSync } from "node:fs"
import type { Component } from "./components.js"
import {
  functionsPathCandidatesFromProject,
  resolveRuntimeProvider,
  type SupatypeProjectConfig,
} from "./project-config.js"

export function requiredHostComponents(
  config: SupatypeProjectConfig,
  cwd: string = process.cwd(),
): Component[] {
  const provider = resolveRuntimeProvider(config)

  if (provider === "docker") {
    return ["engine"]
  }

  const components: Component[] = ["engine", "server", "postgres"]
  const hasFunctions = functionsPathCandidatesFromProject(config, cwd).some((dir) =>
    existsSync(dir),
  )
  if (hasFunctions) components.push("deno")
  return components
}

export function describeRequiredHostComponents(components: readonly Component[]): string {
  if (components.length === 0) return ""
  return components.join(", ")
}
