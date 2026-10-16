import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { envValueOwner, readEnvFile } from "./env-file.js"
import type { SupatypeProjectConfig } from "./project-config.js"

/**
 * Whether the auth server confirms a new email sign-up by itself, from `auth.email.enableConfirmations`.
 *
 * `supatype dev` used to write `SUPATYPE_MAILER_AUTOCONFIRM=true` on every start with nothing to
 * say otherwise, so a dev stack could not be made to send a confirmation email. Dev (docker and
 * native) and the self-host compose file now all take it from here.
 */
export const MAILER_AUTOCONFIRM_ENV = "SUPATYPE_MAILER_AUTOCONFIRM"

/** `"false"` when the config enables confirmations, `"true"` (today's default) otherwise. */
export function configMailerAutoconfirm(config: SupatypeProjectConfig): "true" | "false" {
  return config.auth?.email?.enableConfirmations === true ? "false" : "true"
}

/**
 * The `SUPATYPE_MAILER_AUTOCONFIRM` the developer wrote into `.env` themselves, or null.
 *
 * A value the CLI wrote carries the managed marker. An unmarked `true` is what every CLI before
 * `auth.email.enableConfirmations` wrote on each `dev`, so it is not taken as anyone's choice:
 * otherwise turning confirmations on in the config would do nothing in every existing project.
 */
export function ownMailerAutoconfirm(cwd: string): string | null {
  if (envValueOwner(cwd, MAILER_AUTOCONFIRM_ENV) !== "operator") return null
  const value = readEnvFile(cwd)[MAILER_AUTOCONFIRM_ENV]
  return value === undefined || value === "" || value === "true" ? null : value
}

/** What a dev server runs with: the developer's own `.env` value, else the config's. */
export function devMailerAutoconfirm(cwd: string, config: SupatypeProjectConfig): string {
  return ownMailerAutoconfirm(cwd) ?? configMailerAutoconfirm(config)
}

/** `auth.email`, when present, is an object whose `enableConfirmations` is a boolean. */
export function validateAuthEmail(cfg: Record<string, unknown>, filename: string): void {
  const auth = cfg["auth"]
  if (typeof auth !== "object" || auth === null) return
  const email = (auth as Record<string, unknown>)["email"]
  if (email === undefined) return
  if (typeof email !== "object" || email === null || Array.isArray(email)) {
    throw new Error(`${filename}: auth.email must be an object`)
  }
  const flag = (email as Record<string, unknown>)["enableConfirmations"]
  if (flag !== undefined && typeof flag !== "boolean") {
    throw new Error(`${filename}: auth.email.enableConfirmations must be true or false`)
  }
}

/**
 * The `.env` update a dev stack's start makes: the config's value, written with the managed marker
 * so the next start may change it, or nothing when the developer set their own.
 */
export function devMailerAutoconfirmUpdate(cwd: string, config: SupatypeProjectConfig): Record<string, string> {
  return ownMailerAutoconfirm(cwd) === null ? { [MAILER_AUTOCONFIRM_ENV]: configMailerAutoconfirm(config) } : {}
}

/**
 * The native dev server's value, applied over what it reads from `.env` and `.env.local`.
 *
 * Nothing when `.env.local` sets it: the CLI never writes that file, so a value there is the
 * developer's and already wins. Otherwise the developer's own `.env` value, else the config's, so
 * an unmarked `true` an earlier docker `dev` left in `.env` does not outvote the config.
 */
export function nativeMailerAutoconfirmEnv(cwd: string, config: SupatypeProjectConfig): Record<string, string> {
  const local = join(cwd, ".env.local")
  const inLocal = existsSync(local) && new RegExp(`^\s*${MAILER_AUTOCONFIRM_ENV}=`, "m").test(readFileSync(local, "utf8"))
  return inLocal ? {} : { [MAILER_AUTOCONFIRM_ENV]: devMailerAutoconfirm(cwd, config) }
}
