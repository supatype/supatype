import React from "react"
import type { ModelConfig } from "../config.js"
import { Card } from "../components/ui.js"
import { Badge } from "../components/ui.js"
import { cn } from "../lib/utils.js"
import { useProjectProxy } from "../hooks/useProjectProxy.js"
import { useApiQuery } from "../hooks/useApiQuery.js"

interface ModelSchemaProps {
  model: ModelConfig
}

export function ModelSchema({ model }: ModelSchemaProps): React.ReactElement {
  const proxy = useProjectProxy()

  const { data: tables, loading } = useApiQuery(
    () => proxy.introspect(),
    [proxy],
  )

  const liveTable = tables?.find((t) => t.name === model.tableName) ?? null

  // Build a merged field list: join config fields + live DB columns by name
  const configFieldMap = new Map(model.fields.map((f) => [f.name, f]))
  const liveColMap = new Map((liveTable?.columns ?? []).map((c) => [c.name, c]))

  // Union of all known field names, DB columns first (natural table order), then any config-only fields
  const allNames = [
    ...(liveTable?.columns ?? []).map((c) => c.name),
    ...model.fields.filter((f) => !liveColMap.has(f.name)).map((f) => f.name),
  ]

  // Relations from live DB (FK columns)
  const relations = (liveTable?.columns ?? [])
    .filter((c) => c.is_foreign_key && c.references)
    .map((c) => ({
      field: c.name,
      references: c.references!,
    }))

  return (
    <div className="max-w-4xl space-y-5">
      {/* Overview */}
      <Card>
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Overview</h2>
        </div>
        <div className="divide-y divide-border">
          <MetaRow label="Model name"  value={model.name} mono />
          <MetaRow label="Table"       value={model.tableName} mono />
          <MetaRow label="Primary key" value={model.primaryKey} mono />
          <MetaRow label="Timestamps"  value={model.timestamps ? "Enabled" : "Disabled"} />
          <MetaRow label="Versioning"  value={model.versioning ? "Enabled" : "Disabled"} />
          <MetaRow label="Soft delete" value={model.softDelete ? "Enabled" : "Disabled"} />
          <MetaRow label="Publishable" value={model.publishable ? "Enabled" : "Disabled"} />
        </div>
      </Card>

      {/* Fields — merged config + live DB */}
      <Card>
        <div className="px-4 py-3 border-b border-border flex items-center gap-3">
          <div>
            <h2 className="text-sm font-semibold">Fields</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{allNames.length} fields</p>
          </div>
          {loading && (
            <div className="ml-auto animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent" />
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <Th>Name</Th>
                <Th>Label</Th>
                <Th>Widget</Th>
                <Th>SQL Type</Th>
                <Th>Nullable</Th>
                <Th>Default</Th>
                <Th>Constraints</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {allNames.map((name) => {
                const cfg = configFieldMap.get(name)
                const col = liveColMap.get(name)
                return (
                  <tr key={name} className="hover:bg-muted/20 transition-colors">
                    <Td>
                      <code className="font-mono text-xs">{name}</code>
                    </Td>
                    <Td className="text-muted-foreground">{cfg?.label ?? "—"}</Td>
                    <Td>
                      {cfg ? (
                        <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                          {cfg.widget}
                        </span>
                      ) : <span className="text-muted-foreground/40">—</span>}
                    </Td>
                    <Td>
                      {col ? (
                        <code className="text-xs text-primary">{col.type}</code>
                      ) : <span className="text-muted-foreground/40">—</span>}
                    </Td>
                    <Td>
                      {col ? (col.nullable ? "yes" : "no") : <span className="text-muted-foreground/40">—</span>}
                    </Td>
                    <Td className="text-xs text-muted-foreground">
                      {col?.default_value ?? "—"}
                    </Td>
                    <Td>
                      <div className="flex gap-1">
                        {col?.is_primary ? <Badge variant="indigo">PK</Badge> : null}
                        {col?.is_unique && !col?.is_primary ? <Badge variant="green">UQ</Badge> : null}
                        {col?.is_indexed && !col?.is_primary ? <Badge variant="blue">IDX</Badge> : null}
                        {col?.is_foreign_key ? <Badge variant="yellow">FK</Badge> : null}
                        {cfg?.required && !col?.is_primary ? <Badge variant="red">REQ</Badge> : null}
                      </div>
                    </Td>
                  </tr>
                )
              })}
              {allNames.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No fields defined.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Relations */}
      {relations.length > 0 && (
        <Card>
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold">Relations</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <Th>Field</Th>
                  <Th>References</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {relations.map((rel) => (
                  <tr key={rel.field} className="hover:bg-muted/20 transition-colors">
                    <Td><code className="font-mono text-xs">{rel.field}</code></Td>
                    <Td><code className="text-xs text-primary">{rel.references}</code></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* API */}
      <Card>
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">API Exposure</h2>
        </div>
        <div className="divide-y divide-border">
          <MetaRow label="REST endpoint" value={`/rest/v1/${model.tableName}`} mono />
          <MetaRow label="GraphQL type"  value={`${model.label}Node`} mono />
        </div>
      </Card>
    </div>
  )
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }): React.ReactElement {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      {mono
        ? <code className="text-sm font-mono bg-muted px-2 py-0.5 rounded">{value}</code>
        : <span className="text-sm">{value}</span>
      }
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </th>
  )
}

function Td({ children, className }: { children: React.ReactNode; className?: string }): React.ReactElement {
  return <td className={cn("px-4 py-2.5", className)}>{children}</td>
}
