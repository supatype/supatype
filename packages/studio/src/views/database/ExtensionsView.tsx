import React, { useState } from "react"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { useSqlEditorOffered } from "../../hooks/useSqlEditorOffered.js"
import { useApiQuery } from "../../hooks/useApiQuery.js"
import { Badge, Button, Card, Input } from "../../components/ui.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { cellText, cellTextOrNull } from "../metadata-row.js"

export function ExtensionsView(): React.ReactElement {
  const proxy = useProjectProxy()
  // Writes go through `/studio-admin/extensions`, open to the SQL editor's roles only (RQ4, SQ2).
  const sqlWrites = useSqlEditorOffered()
  const [search, setSearch] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data: installed, refetch: refetchInstalled } = useApiQuery(
    () => proxy.metadata("extensions_installed").then((r) => r.rows),
    [proxy],
  )
  const { data: available } = useApiQuery(
    () => proxy.metadata("extensions_available").then((r) => r.rows),
    [proxy],
  )

  async function toggleExtension(name: string, enable: boolean) {
    setBusy(name)
    setError(null)
    try {
      await proxy.studioExtension(name, enable)
      refetchInstalled()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const installedNames = new Set((installed ?? []).map((r) => cellText(r, "extname")))
  const filteredAvailable = (available ?? []).filter((r) =>
    !search || cellText(r, "name").toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-foreground">Extensions</h1>

      {error && <ErrorBanner message={error} />}

      {/* Installed */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">Installed ({installed?.length ?? 0})</h2>
        {(installed?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">No extensions installed.</p>
        ) : (
          <Card>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Extension</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Version</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Description</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {installed?.map((row) => (
                  <tr key={cellText(row, "extname")} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 font-mono text-sm text-foreground">{cellText(row, "extname")}</td>
                    <td className="px-4 py-3"><Badge variant="blue">{cellText(row, "extversion")}</Badge></td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{cellTextOrNull(row, "description") ?? "-"}</td>
                    <td className="px-4 py-3 text-right">
                      {sqlWrites ? (
                        <Button
                          variant="destructive"
                          size="xs"
                          disabled={busy === cellText(row, "extname")}
                          onClick={() => { void toggleExtension(cellText(row, "extname"), false) }}
                        >
                          Disable
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {/* Available */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground">Available</h2>
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search extensions…"
            className="w-48"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredAvailable.map((row) => {
            const name = cellText(row, "name")
            const isInstalling = busy === name
            return (
              <div key={name} className="p-3 rounded-lg border border-border bg-card space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-sm text-foreground font-medium">{name}</span>
                  <Badge variant="blue">{cellText(row, "default_version")}</Badge>
                </div>
                {row["comment"] ? <p className="text-xs text-muted-foreground line-clamp-2">{cellText(row, "comment")}</p> : null}
                {sqlWrites ? (
                  <Button
                    variant="primary"
                    size="xs"
                    disabled={isInstalling || installedNames.has(name)}
                    onClick={() => { void toggleExtension(name, true) }}
                  >
                    {isInstalling ? "Enabling…" : "Enable"}
                  </Button>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
