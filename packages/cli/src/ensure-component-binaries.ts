/**
 * Ensure CDN component binaries are cached when the host CLI needs them.
 */

import { ensureBinary } from "./ensure-binary.js"
import type { Component } from "./components.js"
import type { SupatypeProjectConfig } from "./project-config.js"
import {
  describeRequiredHostComponents,
  requiredHostComponents,
} from "./required-host-components.js"
import { resolveRuntimeProvider } from "./project-config.js"
import { error, info, warn } from "./ui/messages.js"

export interface ComponentBinaryFailure {
  component: Component
  message: string
}

export interface EnsureComponentBinariesResult {
  ok: boolean
  failures: ComponentBinaryFailure[]
  skipped: boolean
}

export async function ensureComponentBinaries(
  config: SupatypeProjectConfig,
  cwd: string = process.cwd(),
): Promise<EnsureComponentBinariesResult> {
  const components = requiredHostComponents(config, cwd)
  const provider = resolveRuntimeProvider(config)

  if (components.length === 0) {
    return { ok: true, failures: [], skipped: true }
  }

  const list = describeRequiredHostComponents(components)
  if (provider === "docker") {
    info(
      `Preparing host CLI tools (${list}) — Compose still runs Postgres and the API stack.`,
    )
  } else {
    info(`Preparing local runtime components (${list})…`)
  }

  const failures: ComponentBinaryFailure[] = []

  for (const component of components) {
    try {
      await ensureBinary(component, config)
      info(`${component} ready.`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push({ component, message })
      error(`Could not prepare ${component}: ${message}`)
    }
  }

  return { ok: failures.length === 0, failures, skipped: false }
}

export function reportComponentBinaryFailures(failures: ComponentBinaryFailure[]): void {
  if (failures.length === 0) return

  warn("Some component binaries are still missing.")
  for (const { component, message } of failures) {
    warn(`  ${component}: ${message}`)
  }
  warn("Run manually from your project directory: supatype update")
  warn("If downloads keep failing, check your network or try again in a few minutes.")
}
