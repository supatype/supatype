import React, { useState } from "react"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { useSqlEditorOffered } from "../../hooks/useSqlEditorOffered.js"
import { useApiQuery } from "../../hooks/useApiQuery.js"
import { Badge, Button, Card, ConfirmButton, Input, PageHeader, TableCard, Td, Th, tableRowClass, type DestructiveQuestion } from "../../components/ui.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { cellText, cellTextOrNull } from "../metadata-row.js"

type Row = Record<string, unknown>

/** Disabling drops the extension, and with it every function, type and operator it installed. */
function disableQuestion(name: string): DestructiveQuestion {
  return {
    title: `Disable ${name}?`,
    detail: <p>The extension is dropped, with the functions, types and operators it installed.</p>,
    answer: "Disable extension",
  }
}

/** Switching extensions on and off: which one is switching, why the last switch failed, and the switch. */
interface ExtensionToggle {
  busy: string | null
  error: string | null
  toggle: (name: string, enable: boolean) => Promise<void>
}

function useExtensionToggle(onDone: () => void): ExtensionToggle {
  const proxy = useProjectProxy()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const toggle = async (name: string, enable: boolean): Promise<void> => {
    setBusy(name)
    setError(null)
    try {
      await proxy.studioExtension(name, enable)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  return { busy, error, toggle }
}

export function ExtensionsView(): React.ReactElement {
  const proxy = useProjectProxy()
  // Writes go through `/studio-admin/extensions`, open to the SQL editor's roles only (RQ4, SQ2).
  const sqlWrites = useSqlEditorOffered()
  const { data: installed, refetch: refetchInstalled } = useApiQuery(() => proxy.metadata("extensions_installed").then((r) => r.rows), [proxy])
  const { data: available } = useApiQuery(() => proxy.metadata("extensions_available").then((r) => r.rows), [proxy])
  const extensions = useExtensionToggle(refetchInstalled)
  const toggle = sqlWrites ? extensions : null
  return (
    <div className="space-y-6">
      <PageHeader title="Extensions" />
      {extensions.error && <ErrorBanner message={extensions.error} />}
      <InstalledExtensions rows={installed ?? []} toggle={toggle} />
      <AvailableExtensions rows={available ?? []} installed={new Set((installed ?? []).map((r) => cellText(r, "extname")))} toggle={toggle} />
    </div>
  )
}

/** The installed extensions, each with Disable for a role that may write. */
function InstalledExtensions({ rows, toggle }: { rows: Row[]; toggle: ExtensionToggle | null }): React.ReactElement {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-foreground">Installed ({rows.length})</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No extensions installed.</p>
      ) : (
        <TableCard head={<><Th>Extension</Th><Th>Version</Th><Th>Description</Th><Th /></>}>
          {rows.map((row) => <InstalledRow key={cellText(row, "extname")} row={row} toggle={toggle} />)}
        </TableCard>
      )}
    </div>
  )
}

function InstalledRow({ row, toggle }: { row: Row; toggle: ExtensionToggle | null }): React.ReactElement {
  const name = cellText(row, "extname")
  return (
    <tr className={tableRowClass(false)}>
      <Td className="font-mono text-foreground">{name}</Td>
      <Td><Badge variant="blue">{cellText(row, "extversion")}</Badge></Td>
      <Td className="text-xs text-muted-foreground">{cellTextOrNull(row, "description") ?? "-"}</Td>
      <Td className="text-right">
        {toggle ? (
          <ConfirmButton variant="destructive" size="xs" disabled={toggle.busy === name} ask={disableQuestion(name)} act={() => { void toggle.toggle(name, false) }}>
            Disable
          </ConfirmButton>
        ) : null}
      </Td>
    </tr>
  )
}

/** Every extension the server offers, searchable by name, each with Enable for a role that may write. */
function AvailableExtensions({ rows, installed, toggle }: { rows: Row[]; installed: Set<string>; toggle: ExtensionToggle | null }): React.ReactElement {
  const [search, setSearch] = useState("")
  const shown = rows.filter((r) => !search || cellText(r, "name").toLowerCase().includes(search.toLowerCase()))
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">Available</h2>
        <Input type="text" value={search} onChange={(e) => { setSearch(e.target.value) }} placeholder="Search extensions…" className="w-48" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {shown.map((row) => <AvailableCard key={cellText(row, "name")} row={row} installed={installed.has(cellText(row, "name"))} toggle={toggle} />)}
      </div>
    </div>
  )
}

function AvailableCard({ row, installed, toggle }: { row: Row; installed: boolean; toggle: ExtensionToggle | null }): React.ReactElement {
  const name = cellText(row, "name")
  const enabling = toggle?.busy === name
  return (
    <Card className="p-3 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-sm text-foreground font-medium">{name}</span>
        <Badge variant="blue">{cellText(row, "default_version")}</Badge>
      </div>
      {row["comment"] ? <p className="text-xs text-muted-foreground line-clamp-2">{cellText(row, "comment")}</p> : null}
      {toggle ? (
        <Button variant="primary" size="xs" disabled={enabling || installed} onClick={() => { void toggle.toggle(name, true) }}>
          {enabling ? "Enabling…" : "Enable"}
        </Button>
      ) : null}
    </Card>
  )
}
