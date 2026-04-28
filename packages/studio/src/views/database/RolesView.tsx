import React from "react"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { useApiQuery } from "../../hooks/useApiQuery.js"
import { Badge, Card } from "../../components/ui.js"
import { EmptyState } from "../../components/EmptyState.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"

const LIST_QUERY = `
  SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
         rolcanlogin, rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil
  FROM pg_roles
  WHERE rolname NOT LIKE 'pg_%'
  ORDER BY rolname
`

export function RolesView(): React.ReactElement {
  const proxy = useProjectProxy()

  const { data: roles, loading, error } = useApiQuery(
    () => proxy.sql(LIST_QUERY).then((r) => r.rows),
    [proxy],
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">Roles</h1>
        <a
          href="/database/sql"
          className="text-xs text-primary hover:underline"
        >
          Manage roles in SQL Runner →
        </a>
      </div>

      {error && <ErrorBanner message={error} />}

      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />)}</div>
      ) : roles?.length === 0 ? (
        <EmptyState title="No roles" description="No non-system roles found." />
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Capabilities</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Connections</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">Expires</th>
              </tr>
            </thead>
            <tbody>
              {roles?.map((row) => {
                const caps: string[] = []
                if (row["rolsuper"]) caps.push("superuser")
                if (row["rolcanlogin"]) caps.push("login")
                if (row["rolreplication"]) caps.push("replication")
                if (row["rolbypassrls"]) caps.push("bypass RLS")
                if (row["rolcreatedb"]) caps.push("createdb")
                if (row["rolcreaterole"]) caps.push("createrole")
                return (
                  <tr key={row["rolname"] as string} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 font-mono text-sm text-foreground">{row["rolname"] as string}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {caps.map((c) => <Badge key={c} variant="blue">{c}</Badge>)}
                        {caps.length === 0 && <span className="text-xs text-muted-foreground">—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{(row["rolconnlimit"] as number) === -1 ? "unlimited" : String(row["rolconnlimit"])}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{(row["rolvaliduntil"] as string | null) ?? "never"}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
