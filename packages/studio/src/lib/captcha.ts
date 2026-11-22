import { CAPTCHA_PROVIDERS } from "@supatype/types"
import { isJsonObject } from "./json.js"

export type CaptchaProvider = (typeof CAPTCHA_PROVIDERS)[number]

/** The project's captcha, as the auth server's public settings report it: who runs it and the public key. */
export interface CaptchaSettings {
  provider: CaptchaProvider
  siteKey: string
}

/** Where each provider serves the script that draws its widget. Explicit render: Studio draws it. */
export const CAPTCHA_SCRIPTS: Readonly<Record<CaptchaProvider, string>> = {
  hcaptcha: "https://js.hcaptcha.com/1/api.js?render=explicit",
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
}

function isCaptchaProvider(value: unknown): value is CaptchaProvider {
  return CAPTCHA_PROVIDERS.some((provider) => provider === value)
}

/**
 * The `captcha` block of the auth server's settings answer, or null when captcha is off or the block
 * is one Studio cannot draw (an older server omits it, an unknown provider, no site key).
 */
export function readCaptcha(raw: unknown): CaptchaSettings | null {
  if (!isJsonObject(raw)) return null
  const provider = raw["provider"]
  const siteKey = raw["site_key"]
  if (!isCaptchaProvider(provider) || typeof siteKey !== "string" || siteKey.trim() === "") return null
  return { provider, siteKey: siteKey.trim() }
}
