import React from "react"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { useAuthSettings } from "../../hooks/useAuthSettings.js"
import { usePlatform } from "../../hooks/usePlatform.js"
import { oauthProviderRows, SettingsLoading, SettingsTable } from "./AuthSettingsTable.js"

/**
 * The project's OAuth providers, as its auth server reports them in `GET /auth/v1/settings`, the
 * same source the Configuration page reads.
 *
 * Read-only on purpose. This page used to show a hard-coded list, every provider disabled, with
 * Enable and Configure buttons that changed only the page's own state. No host accepts a provider
 * change from Studio: self-host renders them from `auth.providers` in supatype.config.ts (or
 * `SUPATYPE_EXTERNAL_*` in `.env`) when the stack starts, and Cloud manages them.
 */

function howToChange(cloud: boolean): string {
  return cloud
    ? "OAuth providers are managed by Supatype Cloud for this project and cannot be changed from Studio."
    : "OAuth providers come from auth.providers in supatype.config.ts, or SUPATYPE_EXTERNAL_<PROVIDER>_* in the project's .env, which wins. Change them there and restart the stack. Studio cannot change them."
}

export function ProvidersView(): React.ReactElement {
  const { settings, error, loading } = useAuthSettings()
  const cloud = usePlatform().platformUrl !== undefined
  const rows = settings ? oauthProviderRows(settings) : []

  return (
    <div className="space-y-5 max-w-3xl">
      <h1 className="text-xl font-semibold text-foreground">Providers</h1>
      <p className="text-sm text-muted-foreground">{howToChange(cloud)}</p>

      {error && <ErrorBanner message={error} />}
      {loading && <SettingsLoading />}

      {settings &&
        (rows.length > 0 ? (
          <SettingsTable title="OAuth providers" rows={rows} cloud={cloud} />
        ) : (
          <EmptyState title="No OAuth providers reported" description="The auth server reported no OAuth providers." />
        ))}
    </div>
  )
}
