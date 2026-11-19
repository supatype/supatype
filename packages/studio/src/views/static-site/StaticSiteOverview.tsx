import React from "react"
import { Badge, LoadingRows, PageHeader, TextLink } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { FactsCard, type Fact } from "../../components/static-site/FactsCard.js"
import { formatBytes } from "../../lib/cache-health.js"
import { modeLabel, sizeText } from "../../lib/static-site.js"
import { useRequiredStaticSiteHost, type LiveSite, type StaticSiteOverview as Overview } from "../../lib/static-site-host.js"

function Mono({ children }: { children: string }): React.ReactElement {
  return <code className="font-mono text-xs text-foreground">{children}</code>
}

function addressFact(address: string | null): Fact {
  return {
    label: "Site address",
    value: address === null ? "Not set" : <TextLink href={address} target="_blank" rel="noopener noreferrer" className="font-mono text-xs">{address}</TextLink>,
  }
}

/** What is being served, which differs by mode: a directory with files, or another server. */
function servedFacts(site: Overview): Fact[] {
  const serving = { label: "Status", value: <Badge variant={site.serving ? "green" : "outline"}>{site.serving ? "Serving" : "Not serving"}</Badge> }
  if (site.mode === "static") {
    return [
      serving,
      ...(site.staticDir !== null ? [{ label: "Serving from", value: <Mono>{site.staticDir}</Mono> }] : []),
      { label: "Files", value: site.fileCount === null ? "Not counted" : String(site.fileCount) },
      { label: "Total size", value: sizeText(site.totalBytes) },
    ]
  }
  return [serving, ...(site.upstream !== null ? [{ label: "Proxying to", value: <Mono>{site.upstream}</Mono> }] : [])]
}

function siteFacts(site: Overview): Fact[] {
  return [addressFact(site.address), { label: "Serving mode", value: modeLabel(site.mode) }, ...servedFacts(site)]
}

/** Cloud's live version: which one, how big it is beside the plan, and when it went live. */
function liveFacts(live: LiveSite): Fact[] {
  const percent = live.planBytes > 0 ? Math.round((live.sizeBytes / live.planBytes) * 100) : 0
  return [
    { label: "Live version", value: <Mono>{live.version}</Mono> },
    {
      label: "Size against plan",
      value: (
        <span className="flex flex-wrap items-center gap-2">
          {formatBytes(live.sizeBytes)} of {formatBytes(live.planBytes)} ({percent}%)
          {live.overPlan && <Badge variant="yellow">Over plan</Badge>}
        </span>
      ),
    },
    { label: "Last deploy", value: live.deployedAt === null ? "Not deployed" : new Date(live.deployedAt).toLocaleString() },
  ]
}

/** The site address, how it is served, and what is being served. The same page on self-host and Cloud. */
export function StaticSiteOverview(): React.ReactElement {
  const { data, loading, error } = useRequiredStaticSiteHost().useOverview()
  return (
    <div className="space-y-5 max-w-3xl">
      <PageHeader title="Static site" />
      {error !== null && <ErrorBanner message={error} />}
      {loading && data === null && <LoadingRows />}
      {data !== null && data.mode === "none" && (
        <EmptyState
          title="No site is being served"
          description="Nothing answers requests to the site address yet. Set app in supatype.config.ts and run supatype dev, or on Cloud run supatype deploy."
        />
      )}
      {data !== null && data.mode !== "none" && <FactsCard title="Site" facts={siteFacts(data)} />}
      {data?.live !== undefined && <FactsCard title="Live version" facts={liveFacts(data.live)} />}
    </div>
  )
}
