import { upsertEnvFile } from "./env-file.js"
import { MAILER_PASSTHROUGH_ENV, MAILER_PROVIDER_ENV, mailerProviderEnv, SMTP_ENV } from "./mailer-env.js"
import type { SupatypeProjectConfig } from "./project-config.js"

/** Every `.env` name the CLI writes from `email` in the config. */
export const CONFIG_MAILER_ENV_KEYS: readonly string[] = [MAILER_PROVIDER_ENV, ...SMTP_ENV, ...MAILER_PASSTHROUGH_ENV]

/**
 * The mailer values `config` gives, as `.env` updates, and how they are written: each under the
 * managed marker, and a marked value the config no longer gives taken out.
 *
 * Every command that starts a stack writes them from the config it starts with. Only `dev` used
 * to, from the config with `supatype.local.config.ts` laid over it, so `self-host compose up`
 * started production with dev's mail catcher (issue 74) and with dev's last
 * `SUPATYPE_MAILER_AUTOCONFIRM` rather than the config's (issue 75). A value the developer wrote
 * by hand carries no marker and is only replaced where the config sets that name.
 *
 * `SUPATYPE_MAILER_AUTOCONFIRM` is not among them: the compose file carries the config's value as
 * its fallback, so `.env` holds only the developer's own (FF7). Each command that starts a stack
 * takes the line an earlier CLI wrote there out first, with `retireCliMailerAutoconfirm`.
 */
export function configMailerEnv(config: SupatypeProjectConfig): {
  updates: Record<string, string>
  managed: readonly string[]
  removeManaged: readonly string[]
} {
  const updates = mailerProviderEnv(config.email)
  return {
    updates,
    managed: CONFIG_MAILER_ENV_KEYS,
    removeManaged: CONFIG_MAILER_ENV_KEYS.filter((key) => !(key in updates)),
  }
}

/**
 * Warn when the provider is SMTP and no host is set, in the config or in `environment` (`.env` with
 * the shell over it, as the stack resolves the name): the auth server then uses its noop mailer and
 * every email is dropped without a word (issue 76).
 */
export function warnSmtpWithoutHost(
  config: SupatypeProjectConfig,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (config.email?.provider !== "smtp") return
  if (mailerProviderEnv(config.email).SUPATYPE_SMTP_HOST !== undefined || environment["SUPATYPE_SMTP_HOST"]?.trim()) return
  console.warn(
    "[supatype] email.provider is smtp but no SMTP host is set, so no email will be sent. " +
      "Set email.smtp.host in supatype.config.ts or SUPATYPE_SMTP_HOST in .env.",
  )
}

/** Write {@link configMailerEnv} into `.env`, for a command that writes nothing else there. */
export function syncConfigMailerEnv(cwd: string, config: SupatypeProjectConfig): void {
  const { updates, managed, removeManaged } = configMailerEnv(config)
  upsertEnvFile(cwd, updates, { managed, removeManaged })
}
