import React from "react"
import { useProjectProxy } from "../../hooks/useProjectProxy.js"
import { useApiQuery } from "../../hooks/useApiQuery.js"
import { Badge, PageHeader, Td, TextLink, Th, tableRowClass } from "../../components/ui.js"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { CatalogueTable } from "../../components/database/CatalogueTable.js"
import { useStudioCapability } from "../../hooks/useStudioCapability.js"
import { SQL_EDITOR_HREF, sqlEditorOffered } from "../../lib/sql-editor-access.js"
import { cellText, cellTextOrNull } from "../metadata-row.js"

type Row = Record<string, unknown>

/** The role attributes a row lists, each under the word it reads as. */
const CAPABILITIES: Array<[string, string]> = [
  ["rolsuper", "superuser"],
  ["rolcanlogin", "login"],
  ["rolreplication", "replication"],
  ["rolbypassrls", "bypass RLS"],
  ["rolcreatedb", "createdb"],
  ["rolcreaterole", "createrole"],
]

export function RolesView(): React.ReactElement {
  const proxy = useProjectProxy()
  const capability = useStudioCapability()
  const { data: roles, loading, error } = useApiQuery(() => proxy.metadata("roles").then((r) => r.rows), [proxy])
  const manage = sqlEditorOffered(capability) ? (
    <TextLink href={SQL_EDITOR_HREF} className="text-xs">Manage roles in SQL Runner →</TextLink>
  ) : null
  return (
    <div className="space-y-4">
      <PageHeader title="Roles" action={manage} />
      {error && <ErrorBanner message={error} />}
      <CatalogueTable
        list={{ rows: roles, loading, empty: { title: "No roles", description: "No non-system roles found." } }}
        head={<><Th>Name</Th><Th>Capabilities</Th><Th>Connections</Th><Th>Expires</Th></>}
        row={(row) => <RoleRow key={cellText(row, "rolname")} row={row} />}
      />
    </div>
  )
}

function RoleRow({ row }: { row: Row }): React.ReactElement {
  const caps = CAPABILITIES.filter(([column]) => Boolean(row[column])).map(([, word]) => word)
  return (
    <tr className={tableRowClass(false)}>
      <Td className="font-mono text-foreground">{cellText(row, "rolname")}</Td>
      <Td>
        <div className="flex flex-wrap gap-1">
          {caps.map((c) => <Badge key={c} variant="blue">{c}</Badge>)}
          {caps.length === 0 && <span className="text-xs text-muted-foreground">-</span>}
        </div>
      </Td>
      <Td className="text-xs text-muted-foreground">{row["rolconnlimit"] === -1 ? "unlimited" : String(row["rolconnlimit"])}</Td>
      <Td className="text-xs text-muted-foreground">{cellTextOrNull(row, "rolvaliduntil") ?? "never"}</Td>
    </tr>
  )
}
