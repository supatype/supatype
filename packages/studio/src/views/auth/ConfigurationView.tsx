import React from "react"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { useAuthSettings, type AuthSettings } from "../../hooks/useAuthSettings.js"
import { usePlatform } from "../../hooks/usePlatform.js"
import { enabled, providerRows, SettingsLoading, SettingsTable, type SettingRow } from "./AuthSettingsTable.js"

/**
 * The project's auth configuration, as its auth server reports it.
 *
 * Read-only on purpose. No host has a route that changes these from Studio: self-host reads them
 * from the auth server's environment when it starts, and Cloud manages them. A form here could
 * only pretend to save, which is what this page used to do.
 */

function confirmation(autoconfirm: boolean): string {
  return autoconfirm ? "Not required (auto-confirm)" : "Required"
}

function settingRows(s: AuthSettings): SettingRow[] {
  const signups = !s.disable_signup
  return [
    { label: "New signups", value: enabled(signups), on: signups, envVar: "DISABLE_SIGNUP", fromDotEnv: true },
    {
      label: "Email confirmation",
      value: confirmation(s.mailer_autoconfirm),
      on: !s.mailer_autoconfirm,
      envVar: "SUPATYPE_MAILER_AUTOCONFIRM",
      fromDotEnv: true,
    },
    {
      label: "Phone confirmation",
      value: confirmation(s.phone_autoconfirm),
      on: !s.phone_autoconfirm,
      envVar: "SUPATYPE_SMS_AUTOCONFIRM",
      fromDotEnv: false,
    },
    { label: "SMS provider", value: s.sms_provider || "None", on: s.sms_provider !== "", envVar: "SUPATYPE_SMS_PROVIDER", fromDotEnv: false },
    { label: "SAML SSO", value: enabled(s.saml_enabled), on: s.saml_enabled, envVar: "SUPATYPE_SAML_ENABLED", fromDotEnv: false },
    { label: "Passkeys", value: enabled(s.passkeys_enabled), on: s.passkeys_enabled, envVar: "SUPATYPE_PASSKEY_ENABLED", fromDotEnv: false },
  ]
}

function howToChange(cloud: boolean): string {
  return cloud
    ? "These are managed by Supatype Cloud for this project and cannot be changed from Studio."
    : "These come from the auth server's environment when it starts. Change them in the project's .env (or the auth server's environment in your compose file) and restart the stack. Studio cannot change them."
}

export function ConfigurationView(): React.ReactElement {
  const { settings, error, loading } = useAuthSettings()
  const cloud = usePlatform().platformUrl !== undefined

  return (
    <div className="space-y-5 max-w-3xl">
      <h1 className="text-xl font-semibold text-foreground">Configuration</h1>
      <p className="text-sm text-muted-foreground">{howToChange(cloud)}</p>

      {error && <ErrorBanner message={error} />}
      {loading && <SettingsLoading />}

      {settings && <SettingsTable title="Sign-up and confirmation" rows={settingRows(settings)} cloud={cloud} />}
      {settings &&
        (Object.keys(settings.external).length > 0 ? (
          <SettingsTable title="Sign-in methods" rows={providerRows(settings)} cloud={cloud} />
        ) : (
          <EmptyState title="No sign-in methods reported" description="The auth server reported no providers." />
        ))}
    </div>
  )
}
