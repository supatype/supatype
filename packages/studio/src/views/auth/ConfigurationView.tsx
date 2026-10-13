import React from "react"
import { Badge, Card, Td, Th } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { useAuthSettings, type AuthSettings } from "../../hooks/useAuthSettings.js"
import { usePlatform } from "../../hooks/usePlatform.js"

/**
 * The project's auth configuration, as its auth server reports it.
 *
 * Read-only on purpose. No host has a route that changes these from Studio: self-host reads them
 * from the auth server's environment when it starts, and Cloud manages them. A form here could
 * only pretend to save, which is what this page used to do.
 */

interface SettingRow {
  label: string
  value: string
  on: boolean
  /** The variable that sets it on self-host, and whether the generated compose file passes it from `.env`. */
  envVar: string
  fromDotEnv: boolean
}

function enabled(on: boolean): string {
  return on ? "Enabled" : "Disabled"
}

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

function providerRows(s: AuthSettings): SettingRow[] {
  return Object.entries(s.external)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, on]) => ({
      label: name,
      value: enabled(on),
      on,
      envVar: `SUPATYPE_EXTERNAL_${name.toUpperCase()}_ENABLED`,
      fromDotEnv: false,
    }))
}

/** Where a value is set: the `.env` line, the auth server's environment, or Cloud. */
function Source({ row, cloud }: { row: SettingRow; cloud: boolean }): React.ReactElement {
  if (cloud) return <span className="text-muted-foreground">Managed by Supatype Cloud</span>
  return (
    <span className="text-muted-foreground">
      {row.fromDotEnv ? ".env " : "auth server env "}
      <code className="font-mono text-xs text-foreground">{row.envVar}</code>
    </span>
  )
}

function SettingsTable({ title, rows, cloud }: { title: string; rows: SettingRow[]; cloud: boolean }): React.ReactElement {
  return (
    <Card>
      <h3 className="text-sm font-medium text-foreground px-4 pt-4 pb-2">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <Th className="px-4 py-2.5">Setting</Th>
              <Th className="px-4 py-2.5">Value</Th>
              <Th className="px-4 py-2.5">Set by</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-border last:border-0">
                <Td className="px-4 py-3">{row.label}</Td>
                <Td className="px-4 py-3">
                  <Badge variant={row.on ? "green" : "outline"}>{row.value}</Badge>
                </Td>
                <Td className="px-4 py-3">
                  <Source row={row} cloud={cloud} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function howToChange(cloud: boolean): string {
  return cloud
    ? "These are managed by Supatype Cloud for this project and cannot be changed from Studio."
    : "These come from the auth server's environment when it starts. Change them in the project's .env (or the auth server's environment in your compose file) and restart the stack. Studio cannot change them."
}

function Loading(): React.ReactElement {
  return (
    <div className="space-y-2">
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />
      ))}
    </div>
  )
}

export function ConfigurationView(): React.ReactElement {
  const { settings, error, loading } = useAuthSettings()
  const cloud = usePlatform().platformUrl !== undefined

  return (
    <div className="space-y-5 max-w-3xl">
      <h1 className="text-xl font-semibold text-foreground">Configuration</h1>
      <p className="text-sm text-muted-foreground">{howToChange(cloud)}</p>

      {error && <ErrorBanner message={error} />}
      {loading && <Loading />}

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
