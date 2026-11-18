import { AUTH_HOOK_NAMES, CAPTCHA_PROVIDERS, PASSWORD_CHARACTER_CLASSES, SMS_PROVIDERS, type AuthHookName } from "@supatype/types"
import type { SettingKind, SettingSpec } from "./CloudAuthParts.js"

/**
 * What the Cloud pages edit beyond sign-in basics: one SettingSpec per saved path of the shared auth
 * settings model. Every spec is `reported`, so a control plane too old to know a path shows that row
 * as "Not available" instead of an editor that cannot work.
 */

function spec(path: string, label: string, kind: SettingKind, extra: Partial<SettingSpec> = {}): SettingSpec {
  return { path: `auth.${path}`, label, kind, reported: true, ...extra }
}

const bool = (path: string, label: string, defaultOn = false): SettingSpec => spec(path, label, "bool", { defaultOn })
const num = (path: string, label: string): SettingSpec => spec(path, label, "number")
const text = (path: string, label: string): SettingSpec => spec(path, label, "text")

export const HOOK_TITLES: Readonly<Record<AuthHookName, string>> = {
  customAccessToken: "Custom access token",
  beforeUserCreated: "Before user created",
  afterUserCreated: "After user created",
  mfaVerificationAttempt: "MFA verification attempt",
  passwordVerificationAttempt: "Password verification attempt",
  sendEmail: "Send email",
  sendSms: "Send SMS",
}

export const HOOK_NAMES: readonly AuthHookName[] = AUTH_HOOK_NAMES

/** The two settings of one hook. Its signing secret is a secret row, `hooks.<name>.secrets`. */
export function hookSpecs(name: AuthHookName): SettingSpec[] {
  const title = HOOK_TITLES[name]
  return [
    { ...bool(`hooks.${name}.enabled`, `${title} hook enabled`), onWhenSet: `auth.hooks.${name}.uri` },
    text(`hooks.${name}.uri`, `${title} hook URI`),
  ]
}

export const CAPTCHA_SPECS: SettingSpec[] = [
  bool("captcha.enabled", "CAPTCHA enabled"),
  spec("captcha.provider", "CAPTCHA provider", "select", { options: CAPTCHA_PROVIDERS }),
]

export const PASSWORD_SPECS: SettingSpec[] = [
  bool("password.leakedPasswordCheck", "Leaked password check"),
  num("password.minLength", "Minimum password length"),
  spec("password.requiredCharacters", "Required characters", "multi", { options: PASSWORD_CHARACTER_CLASSES }),
]

export const RATE_LIMIT_SPECS: SettingSpec[] = [
  num("rateLimits.otp", "OTP requests per 5 minutes"),
  num("rateLimits.tokenRefresh", "Token refreshes per 5 minutes"),
  num("rateLimits.verify", "Verify requests per 5 minutes"),
  num("rateLimits.smsSent", "SMS sent per hour"),
  num("rateLimits.anonymousUsers", "Anonymous sign-ins per 5 minutes"),
  num("rateLimits.sso", "SSO requests per 5 minutes"),
  num("rateLimits.mfa", "MFA challenges and verifies per 5 minutes"),
]

export const SESSION_SPECS: SettingSpec[] = [
  num("sessions.timebox", "Session time limit (seconds)"),
  num("sessions.inactivityTimeout", "Inactivity timeout (seconds)"),
  bool("sessions.singlePerUser", "Single session per user"),
  bool("security.refreshTokenRotation", "Refresh token rotation", true),
  num("security.refreshTokenReuseInterval", "Refresh token reuse interval (seconds)"),
  bool("security.updatePasswordRequireReauthentication", "Password change requires reauthentication"),
  bool("security.updatePasswordRequireCurrentPassword", "Password change requires current password"),
  bool("security.manualLinking", "Manual identity linking"),
]

export const MFA_SPECS: SettingSpec[] = [
  bool("mfa.totp.enroll", "Authenticator app enrol", true),
  bool("mfa.totp.verify", "Authenticator app verify", true),
  bool("mfa.phone.enroll", "Phone enrol"),
  bool("mfa.phone.verify", "Phone verify"),
  num("mfa.maxEnrolledFactors", "Maximum enrolled factors"),
  num("mfa.maxVerifiedFactors", "Maximum verified factors"),
]

export const ANONYMOUS_SPECS: SettingSpec[] = [bool("anonymous.enabled", "Anonymous sign-in")]

export const SAML_SPECS: SettingSpec[] = [
  bool("sso.saml.enabled", "SAML enabled"),
  bool("sso.saml.allowEncryptedAssertions", "Allow encrypted assertions"),
  num("sso.saml.relayStateValidity", "Relay state validity (seconds)"),
  num("sso.saml.rateLimitAssertion", "Assertion rate limit per 5 minutes"),
]

export const PHONE_COMMON_SPECS: SettingSpec[] = [
  bool("phone.enabled", "Phone sign-in"),
  spec("phone.provider", "SMS provider", "select", { options: SMS_PROVIDERS }),
  num("phone.otpLength", "Code length (digits)"),
  num("phone.otpExpiry", "Code lifetime (seconds)"),
  num("phone.maxFrequency", "Minimum seconds between codes"),
]

/** The fields and secret one SMS provider reads, and nothing of the other four. */
export interface SmsProviderFields {
  specs: SettingSpec[]
  secret: { key: string; label: string }
}

const SMS_PROVIDER_FIELDS: Readonly<Record<string, SmsProviderFields>> = {
  twilio: {
    specs: [text("phone.twilio.accountSid", "Twilio account SID"), text("phone.twilio.messageServiceSid", "Twilio message service SID"), text("phone.twilio.contentSid", "Twilio content SID")],
    secret: { key: "phone.twilio.authToken", label: "Twilio auth token" },
  },
  twilio_verify: {
    specs: [text("phone.twilioVerify.accountSid", "Twilio Verify account SID"), text("phone.twilioVerify.messageServiceSid", "Twilio Verify message service SID")],
    secret: { key: "phone.twilioVerify.authToken", label: "Twilio Verify auth token" },
  },
  messagebird: {
    specs: [text("phone.messagebird.originator", "MessageBird originator")],
    secret: { key: "phone.messagebird.accessKey", label: "MessageBird access key" },
  },
  textlocal: {
    specs: [text("phone.textlocal.sender", "Textlocal sender")],
    secret: { key: "phone.textlocal.apiKey", label: "Textlocal API key" },
  },
  vonage: {
    specs: [text("phone.vonage.apiKey", "Vonage API key"), text("phone.vonage.from", "Vonage from")],
    secret: { key: "phone.vonage.apiSecret", label: "Vonage API secret" },
  },
}

/** The chosen provider's fields, or undefined when none is chosen or the name is not one we know. */
export function smsProviderFields(provider: string | null): SmsProviderFields | undefined {
  return provider === null ? undefined : SMS_PROVIDER_FIELDS[provider]
}
