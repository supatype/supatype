import type { ComposeRenderMode } from "./compose-render-mode.js"
import { readEnvSnapshot, upsertEnvFile } from "./env-file.js"
import type { SupatypeProjectConfig } from "./project-config.js"
import { isJsonObject } from "@supatype/shared"

/**
 * Whether the auth server confirms a new email sign-up by itself, from `auth.email.enableConfirmations`.
 *
 * The compose file's `${SUPATYPE_MAILER_AUTOCONFIRM:-<config>}` and native dev's environment carry
 * the config's value, and a line in `.env` is the developer's and wins. The CLI used to write the
 * value into `.env` under the managed marker and rewrite it on every start, so the auth docs'
 * instruction to edit `.env` and restart was undone by the restart (FF7, 0.9.1 release test).
 */
export const MAILER_AUTOCONFIRM_ENV = "SUPATYPE_MAILER_AUTOCONFIRM"

/**
 * The auth server's switch for email-and-password sign-up and sign-in (its
 * `External.Email.Enabled`), from `auth.email.enabled`. Off also turns off magic links and password
 * recovery, which the server refuses with the same "Email logins are disabled".
 */
export const EMAIL_ENABLED_ENV = "SUPATYPE_EXTERNAL_EMAIL_ENABLED"

/**
 * Left in `.env` where {@link retireCliMailerAutoconfirm} took the CLI's line out, so it does that
 * once: a `SUPATYPE_MAILER_AUTOCONFIRM` written after it is the developer's, `true` included.
 */
export const MAILER_AUTOCONFIRM_NOTE =
  "# SUPATYPE_MAILER_AUTOCONFIRM: auth.email.enableConfirmations in supatype.config.ts decides it; a line here wins."

/**
 * `"false"` when the config enables confirmations, `"true"` when it turns them off, and when it does
 * not say, the stack's default: a dev stack confirms a sign-up at once, a standalone (self-hosted)
 * one sends a confirmation link. Self-host used to auto-confirm as well, so anyone could sign up
 * there with an address they do not own (0.9.1 release test, D6).
 */
export function configMailerAutoconfirm(config: SupatypeProjectConfig, mode: ComposeRenderMode): "true" | "false" {
  const confirmations = config.auth?.email?.enableConfirmations ?? mode === "standalone"
  return confirmations ? "false" : "true"
}

/** `"false"` when the config turns email sign-in off, `"true"` (the server's own default) otherwise. */
export function configEmailEnabled(config: SupatypeProjectConfig): "true" | "false" {
  return config.auth?.email?.enabled === false ? "false" : "true"
}

/** `auth.email`, when present, is an object whose `enabled` and `enableConfirmations` are booleans. */
export function validateAuthEmail(cfg: Record<string, unknown>, filename: string): void {
  const auth = cfg["auth"]
  if (!isJsonObject(auth)) return
  const email = auth["email"]
  if (email === undefined) return
  if (!isJsonObject(email)) {
    throw new Error(`${filename}: auth.email must be an object`)
  }
  for (const key of ["enabled", "enableConfirmations"]) {
    const flag = email[key]
    if (flag !== undefined && typeof flag !== "boolean") {
      throw new Error(`${filename}: auth.email.${key} must be true or false`)
    }
  }
}

/**
 * Take the `SUPATYPE_MAILER_AUTOCONFIRM` an earlier CLI wrote out of `.env`, once, saying so in one
 * line: the line under the managed marker, or the unmarked `true` every CLI before the marker wrote.
 * Whether a marked line was edited by hand cannot be told, so it goes too, and the line says how to
 * set it now. Any other value is the developer's and stays. Either way the note goes in where the
 * first line was, so a line written after this is never taken for the CLI's.
 */
export function retireCliMailerAutoconfirm(cwd: string): void {
  const { values, managed, comments } = readEnvSnapshot(cwd)
  if (comments.has(MAILER_AUTOCONFIRM_NOTE) || !(MAILER_AUTOCONFIRM_ENV in values)) return
  const cliWrote = managed.has(MAILER_AUTOCONFIRM_ENV) || values[MAILER_AUTOCONFIRM_ENV] === "true"
  upsertEnvFile(
    cwd,
    {},
    { remove: cliWrote ? [MAILER_AUTOCONFIRM_ENV] : [], noteAt: { key: MAILER_AUTOCONFIRM_ENV, text: MAILER_AUTOCONFIRM_NOTE } },
  )
  if (!cliWrote) return
  console.log(
    `[supatype] Took ${MAILER_AUTOCONFIRM_ENV} out of .env, where an earlier CLI wrote it: set ` +
      "auth.email.enableConfirmations in supatype.config.ts, or a line of your own in .env, to change it.",
  )
}
