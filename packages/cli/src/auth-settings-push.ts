/**
 * The auth step of `supatype push` and `deploy` to a Cloud target: the project's `auth` and `email`
 * settings go to `PUT /projects/:ref/environments/:env/auth/code`, with each secret the config points
 * at (`env("NAME")`) resolved from this machine's shell, then `.env`.
 *
 * A secret this machine does not have is not sent: the control plane keeps the one it stores, or
 * refuses with `missing_secret` when it has none. A setting someone saved in Studio masks the pushed
 * value until it is reset, and the push says so. A self-host target never reaches any of this.
 */
import { authSecretRefs, validateAuthSettings, type AuthSettings } from "@supatype/types"
import { readDotEnvFiles } from "./env-file.js"
import { errorMessage } from "./error-message.js"
import { postApplyFailed } from "./post-apply.js"
import type { SupatypeProjectConfig } from "./project-config.js"
import type { DeployTarget } from "./resolve-target.js"
import { TargetApiError, targetFetch } from "./target-client.js"
import { targetRequest } from "./target-request.js"
import { info, warn } from "./ui/messages.js"
import { withSpinner } from "./ui/progress.js"

export interface AuthPushOptions {
  /** `--reset-auth-overrides`: drop every Studio value first, so the config's apply in full. */
  resetOverrides?: boolean
  /** What `env("NAME")` resolves against. Default: the shell over `.env` and `.env.local`. */
  environment?: Readonly<Record<string, string | undefined>>
}

type MaskedField = { path: string; studioValue: unknown; codeValue: unknown }

interface AuthPushAnswer {
  maskedFields: MaskedField[]
  keptSecrets: string[]
  applied: boolean
}

/** The config's `auth` and `email` sections as the shared settings, or undefined when it has neither. */
export function authSettingsFromConfig(config: SupatypeProjectConfig): AuthSettings | undefined {
  const { auth, email } = config
  if (auth === undefined && email === undefined) return undefined
  const { email: signIn, providers, siteUrl, redirectUrls, disableSignup } = auth ?? {}
  const authPart = {
    ...(signIn !== undefined && { email: signIn }),
    ...(providers !== undefined && { providers }),
    ...(siteUrl !== undefined && { siteUrl }),
    ...(redirectUrls !== undefined && { redirectUrls }),
    ...(disableSignup !== undefined && { disableSignup }),
  }
  const { provider, smtp, resend_api_key, resend_from, ses_from } = email ?? {}
  const emailPart = {
    ...(provider !== undefined && { provider }),
    ...(smtp !== undefined && { smtp }),
    ...(resend_api_key !== undefined && { resend_api_key }),
    ...(resend_from !== undefined && { resend_from }),
    ...(ses_from !== undefined && { ses_from }),
  }
  return {
    ...(auth !== undefined && { auth: authPart }),
    ...(email !== undefined && { email: emailPart }),
  }
}

/** Refuse a config Cloud cannot take (a literal secret, SES), before the schema or anything else is sent. */
export function assertCloudAuthSettings(config: SupatypeProjectConfig, target: Pick<DeployTarget, "mode">): void {
  if (target.mode !== "cloud") return
  const settings = authSettingsFromConfig(config)
  const problems = settings === undefined ? [] : validateAuthSettings(settings, "cloud")
  if (problems.length === 0) return
  throw new Error(`supatype.config.ts cannot be pushed to Supatype Cloud:\n  ${problems.join("\n  ")}`)
}

/** Each secret the settings reference that this machine has, by secret key. Values never leave this map. */
function resolvedSecrets(settings: AuthSettings, environment: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const secrets: Record<string, string> = {}
  for (const { key, envName } of authSecretRefs(settings)) {
    const value = environment[envName]
    if (value !== undefined && value !== "") secrets[key] = value
  }
  return secrets
}

/** A setting's value as a person reads it in a warning. */
function shown(value: unknown): string {
  if (value === null || value === undefined) return "nothing"
  return typeof value === "string" ? value : JSON.stringify(value)
}

function isAnswer(value: unknown): value is AuthPushAnswer {
  return typeof value === "object" && value !== null && Array.isArray((value as { maskedFields?: unknown }).maskedFields)
}

/** Say what the push did: applied or not, each field Studio masks, each secret kept. */
function reportAnswer(answer: unknown, settings: AuthSettings): void {
  const done = isAnswer(answer) ? answer : { maskedFields: [], keptSecrets: [], applied: false }
  info(done.applied ? "Auth settings applied." : "Auth settings written, not yet applied.")
  for (const { path, studioValue, codeValue } of done.maskedFields) {
    warn(
      `${path}: not changed, Studio has ${shown(studioValue)} saved (config says ${shown(codeValue)}); ` +
        "reset it in Studio or push with --reset-auth-overrides",
    )
  }
  const names = new Map(authSecretRefs(settings).map(({ key, envName }) => [key, envName]))
  for (const key of done.keptSecrets) {
    const label = key.replace(/^providers\./, "")
    info(`${label}: ${names.get(key) ?? "the variable"} is not set here, keeping the one stored`)
  }
}

/** The variables a 422 `missing_secret` names, or none when the answer is not that. */
function missingVariables(err: unknown): string[] | undefined {
  if (!(err instanceof TargetApiError) || err.status !== 422 || err.code !== "missing_secret") return undefined
  const missing = err.details?.["missing"]
  if (!Array.isArray(missing)) return []
  return missing.flatMap((entry: unknown) => {
    const name = (entry as { envName?: unknown } | null)?.envName
    return typeof name === "string" ? [name] : []
  })
}

/** An error's text with every secret value taken out, whatever the server echoed. */
function withoutSecrets(text: string, secrets: Readonly<Record<string, string>>): string {
  return Object.values(secrets).reduce((out, value) => out.split(value).join("***"), text)
}

/** Fail the step the way the hooks step fails: the schema is in, this was not, and how to finish. */
function failed(err: unknown, secrets: Readonly<Record<string, string>>): true {
  const missing = missingVariables(err)
  if (missing !== undefined) {
    const names = missing.length > 0 ? missing.join(", ") : "a secret"
    postApplyFailed(
      `the auth settings were not written: ${names} is not set here and no value is stored. Set it in the environment or .env, or in Studio.`,
    )
    return true
  }
  postApplyFailed(`the auth settings were not sent: ${withoutSecrets(errorMessage(err), secrets)}`)
  return true
}

/**
 * Send the project's auth settings to a Cloud target. True when the step failed (it has said so and
 * set the exit code); false when it went through or did not apply: a self-host target, or a project
 * with neither an `auth` nor an `email` section, which keeps the platform defaults and any Studio saves.
 */
export async function pushAuthSettings(
  cwd: string,
  config: SupatypeProjectConfig,
  target: DeployTarget,
  opts: AuthPushOptions = {},
): Promise<boolean> {
  const settings = target.mode === "cloud" ? authSettingsFromConfig(config) : undefined
  if (settings === undefined) return false
  const problems = validateAuthSettings(settings, "cloud")
  if (problems.length > 0) {
    postApplyFailed(`the auth settings are not valid for Supatype Cloud: ${problems.join("; ")}`)
    return true
  }
  const secrets = resolvedSecrets(settings, opts.environment ?? { ...readDotEnvFiles(cwd), ...process.env })
  const body = { settings, secrets, resetOverrides: opts.resetOverrides === true }
  const request = targetRequest(target, { method: "PUT", subpath: `/environments/${target.environment}/auth/code`, body })
  try {
    const answer = await withSpinner("Sending auth settings", () => targetFetch(target.apiBaseUrl, target.apiPrefix, request))
    reportAnswer(answer, settings)
    return false
  } catch (err) {
    return failed(err, secrets)
  }
}
