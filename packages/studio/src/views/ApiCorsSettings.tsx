import React, { useState } from "react"
import { Badge, Button, Card, ConfirmButton, Input, type DestructiveQuestion } from "../components/ui.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { useCorsOrigins, type CorsOrigins } from "../hooks/useCorsOrigins.js"
import { useStudioCapability } from "../hooks/useStudioCapability.js"

/** Where one allowed origin comes from, as the list shows it. */
type OriginSource = "platform" | "site" | "configured" | "saved"

const SOURCE_LABEL: Record<OriginSource, string> = {
  platform: "Platform",
  site: "Site URL",
  configured: "Config",
  saved: "Saved here",
}

function sourceOf(origin: string, data: CorsOrigins): OriginSource {
  if (data.platform.includes(origin)) return "platform"
  // Checked before "saved": the server allows the site URL whatever is saved (SHc).
  if (origin === data.siteOrigin) return "site"
  return data.source === "saved" ? "saved" : "configured"
}

/** Origins the server allows whatever is saved, so nothing here offers to remove them. */
function isFixed(origin: string, data: CorsOrigins): boolean {
  return data.platform.includes(origin) || origin === data.siteOrigin
}

/** A reset throws the saved list away, and the default may allow fewer origins than it did. */
const RESET_QUESTION: DestructiveQuestion = {
  title: "Reset allowed origins to the default?",
  detail: <p>The list saved here is deleted and the default takes over at once. A browser app on an origin only the saved list allowed is refused from then on.</p>,
  answer: "Reset origins",
}

/** Removing an origin refuses it at once, so a browser app served from it stops reaching the API. */
function removeQuestion(origin: string): DestructiveQuestion {
  return {
    title: `Stop allowing ${origin}?`,
    detail: <p>Browsers on this origin are refused as soon as the list is saved, so an app served from it stops reaching the API.</p>,
    answer: "Remove origin",
  }
}

/** The list this page saves: what is in force, less what the server allows anyway. */
function projectList(data: CorsOrigins): string[] {
  return data.origins.filter((o) => !isFixed(o, data))
}

/**
 * Which browser origins may call this project's API: what is in force, where each entry comes
 * from, and for owners, admins and developers, adding, removing and resetting. A change here is saved in the
 * project's database and replaces the default (the site URL plus `api.corsOrigins` and
 * SUPATYPE_CORS_ALLOW_ORIGINS) until it is reset.
 */
export function ApiCorsSettings(): React.ReactElement {
  const cors = useCorsOrigins()
  const capability = useStudioCapability()
  const data = cors.data
  const canEdit = capability.permissions["manageDomains"] === true && data?.editable === true

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Allowed origins</h1>
        <p className="text-sm text-muted-foreground mt-1">
          The web origins a browser may call this project&apos;s API from. Any other origin is refused.
        </p>
      </div>
      {cors.error ? <ErrorBanner message={cors.error} /> : null}
      {cors.loading && !data ? <Card><div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div></Card> : null}
      {data && !data.enforced ? <DevModeNote /> : null}
      {data ? <OriginsCard data={data} canEdit={canEdit} cors={cors} /> : null}
      {data && canEdit ? <AddOriginCard data={data} save={cors.save} /> : null}
      {data && !canEdit ? <ReadOnlyNote data={data} /> : null}
    </div>
  )
}

function DevModeNote(): React.ReactElement {
  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <div className="px-4 py-3 text-xs text-muted-foreground">
        This server runs in dev mode, which allows every origin. The list below is what a standalone
        or Cloud deployment of this project enforces.
      </div>
    </Card>
  )
}

function OriginsCard({ data, canEdit, cors }: {
  data: CorsOrigins
  canEdit: boolean
  cors: ReturnType<typeof useCorsOrigins>
}): React.ReactElement {
  const remove = (origin: string) => void cors.save(projectList(data).filter((o) => o !== origin))
  return (
    <Card>
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">In force</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {data.source === "saved"
              ? `Saved here${data.updatedAt ? ` on ${new Date(data.updatedAt).toLocaleString()}` : ""}, replacing the default.`
              : "The default: the site URL, then api.corsOrigins and SUPATYPE_CORS_ALLOW_ORIGINS."}
          </p>
        </div>
        {canEdit && data.source === "saved" ? (
          <ConfirmButton size="xs" ask={RESET_QUESTION} act={() => void cors.reset()}>Reset to default</ConfirmButton>
        ) : null}
      </div>
      {data.origins.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">No origin is allowed. Browsers can only call this API from its own origin.</div>
      ) : (
        <div className="divide-y divide-border">
          {data.origins.map((origin) => (
            <OriginRow key={origin} origin={origin} source={sourceOf(origin, data)} onRemove={canEdit ? remove : undefined} />
          ))}
        </div>
      )}
      {data.origins.includes("*") ? (
        <div className="px-4 py-3 border-t border-border text-xs text-yellow-400">
          * allows every origin: any website can call this API from a visitor&apos;s browser.
        </div>
      ) : null}
    </Card>
  )
}

function OriginRow({ origin, source, onRemove }: {
  origin: string
  source: OriginSource
  onRemove: ((origin: string) => void) | undefined
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <div className="flex items-center gap-2 min-w-0">
        <code className="text-sm font-mono truncate">{origin}</code>
        <Badge variant={source === "platform" ? "indigo" : source === "saved" ? "blue" : "outline"}>{SOURCE_LABEL[source]}</Badge>
      </div>
      {onRemove && source !== "platform" && source !== "site" ? (
        <ConfirmButton size="xs" variant="ghost" ask={removeQuestion(origin)} act={() => onRemove(origin)}>Remove</ConfirmButton>
      ) : null}
    </div>
  )
}

function AddOriginCard({ data, save }: {
  data: CorsOrigins
  save: (origins: string[]) => Promise<boolean>
}): React.ReactElement {
  const [value, setValue] = useState("")
  const add = async () => {
    const origin = value.trim()
    if (origin === "") return
    if (await save([...projectList(data), origin])) setValue("")
  }
  return (
    <Card>
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold">Add an origin</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          scheme://host[:port], for example https://app.example.com. Saving keeps the list in the
          project&apos;s database, where every server reads it within ten seconds.
        </p>
      </div>
      <form className="flex items-center gap-2 px-4 py-3" onSubmit={(e) => { e.preventDefault(); void add() }}>
        <Input className="font-mono" placeholder="https://app.example.com" value={value} onChange={(e) => setValue(e.target.value)} />
        <Button type="submit" variant="primary" disabled={value.trim() === ""}>Add</Button>
      </form>
    </Card>
  )
}

function ReadOnlyNote({ data }: { data: CorsOrigins }): React.ReactElement {
  return (
    <p className="text-xs text-muted-foreground">
      {data.editable
        ? "Owners, admins and developers can change this list."
        : "This deployment has no database to save a list in; set api.corsOrigins or SUPATYPE_CORS_ALLOW_ORIGINS instead."}
    </p>
  )
}
