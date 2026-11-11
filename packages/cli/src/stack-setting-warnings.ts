import { warnMissingAuthProviderSecrets } from "./auth-providers.js"
import { openKeyspaceNotice } from "./cache-provider.js"
import { warnSmtpWithoutHost } from "./config-mailer-env.js"
import { readEnvFile } from "./env-file.js"
import type { SupatypeProjectConfig } from "./project-config.js"

/**
 * The settings a Docker stack is about to start without, checked against what compose will
 * interpolate: the project's `.env` with the shell over it, read once. One function for `dev` and
 * `self-host compose`, so both say the same thing. A keyspace the image cannot close with a
 * password is one of them (R2-S15).
 */
export function warnMissingStackSettings(cwd: string, config: SupatypeProjectConfig): void {
  const environment = { ...readEnvFile(cwd), ...process.env }
  warnMissingAuthProviderSecrets(config, environment)
  warnSmtpWithoutHost(config, environment)
  const openKeyspace = openKeyspaceNotice(config)
  if (openKeyspace !== null) console.warn(`[supatype] ⚠  ${openKeyspace}`)
}
