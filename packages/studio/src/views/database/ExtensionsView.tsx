import React, { useState } from "react"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { useApiQuery } from "../../hooks/useApiQuery.js"
import { Badge, Button, Card } from "../../components/ui.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"

const INSTALLED_QUERY = `
  SELECT e.extname, e.extversion, d.description
  FROM pg_extension e
  LEFT JOIN pg_description d ON d.objoid = e.oid AND d.classoid = 'pg_extension'::regclass
  ORDER BY e.extname
`

const AVAILABLE_QUERY = `
  SELECT name, default_version, comment
  FROM pg_available_extensions
  WHERE installed_version IS NULL
  ORDER BY name
`

export function ExtensionsView(): React.ReactElement {
  const proxy = useProjectProxy()
  const [search, setSearch] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data: installed, refetch: refetchInstalled } = useApiQuery(
    () => proxy.sql(INSTALLED_QUERY).then((r) => r.rows),
    [proxy],
  )
  const { data: available } = useApiQuery(
    () => proxy.sql(AVAILABLE_QUERY).then((r) => r.rows),
    [proxy],
  )

  async function toggleExtension(name: string, enable: boolean) {
    setBusy(name)
    setError(null)
    try {
      const sql = enable
        ? `CREATE EXTENSION IF NOT EXISTS "${name}";`
        : `DROP EXTENSION IF EXISTS "${name}";`
      await proxy.sql(sql)
      refetchInstalled()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const installedNames = new Set((installed ?? []).map((r) => r["extname"] as string))
  const filteredAvailable = (available ?? []).filter((r) =>
    !search || (r["name"] as string).toLowerCase().includes(search.toLowerCase()),
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
                  <tr key={row["extname"] as string} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 font-mono text-sm text-foreground">{row["extname"] as string}</td>
                    <td className="px-4 py-3"><Badge variant="blue">{row["extversion"] as string}</Badge></td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{(row["description"] as string | null) ?? "—"}</td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="destructive"
                        size="xs"
                        disabled={busy === (row["extname"] as string)}
                        onClick={() => { void toggleExtension(row["extname"] as string, false) }}
                      >
                        Disable
                      </Button>
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
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search extensions…"
            className="px-3 py-1.5 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none w-48"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredAvailable.map((row) => {
            const name = row["name"] as string
            const isInstalling = busy === name
            return (
              <div key={name} className="p-3 rounded-lg border border-border bg-card space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-sm text-foreground font-medium">{name}</span>
                  <Badge variant="blue">{row["default_version"] as string}</Badge>
                </div>
                {row["comment"] ? <p className="text-xs text-muted-foreground line-clamp-2">{row["comment"] as string}</p> : null}
                <Button
                  variant="primary"
                  size="xs"
                  disabled={isInstalling || installedNames.has(name)}
                  onClick={() => { void toggleExtension(name, true) }}
                >
                  {isInstalling ? "Enabling…" : "Enable"}
                </Button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
