import React from "react"
import { Badge, LoadingRows, PageHeader, TextLink } from "../../components/ui.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { FactsCard, type Fact } from "../../components/static-site/FactsCard.js"
import { modeLabel } from "../../lib/static-site.js"
import {
  useRequiredStaticSiteHost,
  type SiteHeader,
  type StaticSiteSettingKey,
  type StaticSiteSettings as Settings,
} from "../../lib/static-site-host.js"

/**
 * Whether the Custom domains link shows on this page. Hidden until custom domains serve the site:
 * a link to a page whose domains do not yet reach the site would promise what is not there. The
 * host still reports `customDomainsPath`, so turning this on is the whole change.
 */
export const CUSTOM_DOMAINS_LINK_VISIBLE = false

/** Where one setting comes from. The config wins over anything else, so a config value is read-only. */
function SetBy({ setting, settings }: { setting: StaticSiteSettingKey; settings: Settings }): React.ReactElement {
  if (settings.fromConfig.includes(setting)) return <Badge variant="blue">Set in supatype.config.ts</Badge>
  return <span className="text-muted-foreground">Default</span>
}

function HeaderList({ headers }: { headers: SiteHeader[] }): React.ReactElement {
  if (headers.length === 0) return <span className="text-muted-foreground">None</span>
  return (
    <ul className="space-y-1">
      {headers.map((header) => (
        <li key={`${header.appliesTo}:${header.name}`} className="text-xs">
          <code className="font-mono text-foreground">{header.name}: {header.value}</code>
          <span className="text-muted-foreground"> ({header.appliesTo})</span>
        </li>
      ))}
    </ul>
  )
}

function settingFacts(settings: Settings): Fact[] {
  return [
    { label: "Serving mode", value: modeLabel(settings.mode), source: <SetBy setting="mode" settings={settings} /> },
    {
      label: "SPA fallback",
      value: <Badge variant={settings.spaFallback ? "green" : "outline"}>{settings.spaFallback ? "On" : "Off"}</Badge>,
      source: <SetBy setting="spaFallback" settings={settings} />,
    },
    { label: "Response headers", value: <HeaderList headers={settings.headers} />, source: <SetBy setting="headers" settings={settings} /> },
  ]
}

/**
 * RESERVED: Public values. Another change adds the card that sets the values a deployed site reads
 * at runtime (the public environment its supatype-env.js carries). Nothing is built here on purpose.
 * Render that card from this component so its place on the page does not move.
 */
function PublicValuesSlot(): null {
  return null
}

function CustomDomainsLink({ path }: { path: string | undefined }): React.ReactElement | null {
  if (!CUSTOM_DOMAINS_LINK_VISIBLE || path === undefined) return null
  return <TextLink to={path} className="text-xs">Custom domains</TextLink>
}

/** Mode, SPA fallback and response headers, and where each is set. The same page on self-host and Cloud. */
export function StaticSiteSettings(): React.ReactElement {
  const { data, loading, error } = useRequiredStaticSiteHost().useSettings()
  return (
    <div className="space-y-5 max-w-3xl">
      <PageHeader title="Static site settings" action={<CustomDomainsLink path={data?.customDomainsPath} />} />
      <p className="text-sm text-muted-foreground">
        A value set in supatype.config.ts wins over any other source and cannot be changed here. Change it in the config and run supatype dev or supatype deploy.
      </p>
      {error !== null && <ErrorBanner message={error} />}
      {loading && data === null && <LoadingRows />}
      {data !== null && <FactsCard title="Serving" facts={settingFacts(data)} />}
      <PublicValuesSlot />
    </div>
  )
}
