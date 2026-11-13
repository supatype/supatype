import React from "react"
import { AUTH_PROVIDER_NAMES } from "@supatype/types"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { Badge, Card, Table } from "../../components/ui.js"
import type { AuthSettingsView } from "../../hooks/useCloudAuthSettings.js"
import { SettingsLoading } from "./AuthSettingsTable.js"
import { AppliedBadge, fieldOf, SecretRow, SettingRow, useCloudAuthEditor, type CloudAuthEditor, type SettingSpec } from "./CloudAuthParts.js"
import { CopyRow } from "./CopyRow.js"

/**
 * The environment's OAuth providers on Cloud: enabled, client id, the callback URL to register, and
 * the write-only client secret. Each environment has its own callback URL.
 */

function specsFor(name: string): SettingSpec[] {
  return [
    { path: `auth.providers.${name}.enabled`, label: `${name} enabled`, kind: "bool" },
    { path: `auth.providers.${name}.clientId`, label: `${name} client ID`, kind: "text" },
  ]
}

function CallbackWarning(): React.ReactElement {
  return (
    <p className="px-4 py-2 text-xs text-muted-foreground">
      Register this callback URL with the provider before signing in. GitHub OAuth apps take one callback URL, so each environment needs its own app.
    </p>
  )
}

function ProviderCard({ name, view, editor }: { name: string; view: AuthSettingsView; editor: CloudAuthEditor }): React.ReactElement {
  const callback = view.callbacks[name]
  const enabled = fieldOf(view, `auth.providers.${name}.enabled`).value === true
  return (
    <Card>
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <h3 className="text-sm font-medium text-foreground">{name}</h3>
        <Badge variant={enabled ? "green" : "outline"}>{enabled ? "Enabled" : "Disabled"}</Badge>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <tbody>
            {specsFor(name).map((spec) => <SettingRow key={spec.path} spec={spec} field={fieldOf(view, spec.path)} editor={editor} />)}
            <SecretRow secretKey={`providers.${name}.secret`} label={name} editor={editor} />
            {callback !== undefined ? <CopyRow label="Callback URL" value={callback} /> : null}
          </tbody>
        </Table>
      </div>
      {callback !== undefined ? <CallbackWarning /> : null}
    </Card>
  )
}

export function CloudProviders({ environment }: { environment: string }): React.ReactElement {
  const editor = useCloudAuthEditor(environment)
  const { view } = editor
  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold text-foreground">Providers</h1>
        <Badge variant="outline">{environment}</Badge>
        {view !== null ? <AppliedBadge view={view} /> : null}
      </div>
      <p className="text-sm text-muted-foreground">
        OAuth providers for this environment. Secrets are write-only: once saved they are never shown again.
        {editor.canEdit ? "" : " Your role can read these settings but not change them."}
      </p>
      {editor.error !== null ? <ErrorBanner message={editor.error} /> : null}
      {editor.loading && view === null ? <SettingsLoading /> : null}
      {view !== null ? AUTH_PROVIDER_NAMES.map((name) => <ProviderCard key={name} name={name} view={view} editor={editor} />) : null}
    </div>
  )
}
