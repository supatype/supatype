import React from "react"
import { Badge, Card, Td, Th } from "../../components/ui.js"
import { NOT_OAUTH, type AuthSettings } from "../../hooks/useAuthSettings.js"

/**
 * The read-only table both auth settings pages draw, and the rows they draw in it, so the
 * Configuration and Providers pages say the same thing about the same `GET /auth/v1/settings`.
 */

export interface SettingRow {
  label: string
  value: string
  on: boolean
  /** The variable that sets it on self-host, and whether the generated compose file passes it from `.env`. */
  envVar: string
  fromDotEnv: boolean
  /** The supatype.config.ts key that renders `envVar`, when there is one. */
  configKey?: string
}

export function enabled(on: boolean): string {
  return on ? "Enabled" : "Disabled"
}

function providerRow(name: string, on: boolean): SettingRow {
  return {
    label: name,
    value: enabled(on),
    on,
    envVar: `SUPATYPE_EXTERNAL_${name.toUpperCase()}_ENABLED`,
    fromDotEnv: false,
    ...(!NOT_OAUTH.has(name) && { configKey: `auth.providers.${name}` }),
  }
}

/** Every sign-in method the server reports, alphabetically. */
export function providerRows(s: AuthSettings): SettingRow[] {
  return Object.entries(s.external)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, on]) => providerRow(name, on))
}

/** The OAuth providers alone, enabled ones first. */
export function oauthProviderRows(s: AuthSettings): SettingRow[] {
  return providerRows(s)
    .filter((row) => row.configKey !== undefined)
    .sort((a, b) => Number(b.on) - Number(a.on))
}

function Code({ children }: { children: string }): React.ReactElement {
  return <code className="font-mono text-xs text-foreground">{children}</code>
}

/** Where a value is set: supatype.config.ts, the `.env` line, the auth server's environment, or Cloud. */
function Source({ row, cloud }: { row: SettingRow; cloud: boolean }): React.ReactElement {
  if (cloud) return <span className="text-muted-foreground">Managed by Supatype Cloud</span>
  if (row.configKey !== undefined) {
    return (
      <span className="text-muted-foreground">
        supatype.config.ts <Code>{row.configKey}</Code>, or <Code>{row.envVar}</Code>
      </span>
    )
  }
  return (
    <span className="text-muted-foreground">
      {row.fromDotEnv ? ".env " : "auth server env "}
      <Code>{row.envVar}</Code>
    </span>
  )
}

export function SettingsTable({ title, rows, cloud }: { title: string; rows: SettingRow[]; cloud: boolean }): React.ReactElement {
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

export function SettingsLoading(): React.ReactElement {
  return (
    <div className="space-y-2">
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />
      ))}
    </div>
  )
}
