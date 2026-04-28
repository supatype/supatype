import React, { useState, useEffect, useMemo, useCallback, useRef } from "react"
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
  BackgroundVariant,
  Panel,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import dagre from "@dagrejs/dagre"
import { cn } from "../lib/utils.js"
import { Badge, Button, Card, Th, Td } from "../components/ui.js"
import { useProjectProxy, type SchemaTable } from "../hooks/useProjectProxy.js"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"

// ─── Types ────────────────────────────────────────────────────────────────────

interface FieldMeta {
  name: string
  type: string
  nullable: boolean
  default_value: string | null
  is_primary: boolean
  is_unique: boolean
  is_indexed: boolean
  references: string | null
  is_foreign_key: boolean
}

interface RelationMeta {
  name: string
  type: "belongsTo" | "hasMany" | "manyToMany"
  from_table: string
  from_field: string
  to_schema: string
  to_table: string
  to_field: string
}

interface TableMeta {
  name: string
  schema: string
  fields: FieldMeta[]
  relations: RelationMeta[]
}

// ─── Data mapping ─────────────────────────────────────────────────────────────

function mapToTableMeta(table: SchemaTable, schema: string): TableMeta {
  const fields: FieldMeta[] = table.columns.map(col => ({
    name: col.name,
    type: col.type,
    nullable: col.nullable,
    default_value: col.default_value,
    is_primary: col.is_primary,
    is_unique: col.is_unique,
    is_indexed: col.is_indexed,
    references: col.references ?? null,
    is_foreign_key: col.is_foreign_key ?? false,
  }))

  const relations: RelationMeta[] = table.columns
    .filter(col => col.is_foreign_key && col.references)
    .map(col => {
      // references_col is now always schema.table.column (3 parts)
      const parts = col.references!.split(".")
      let toSchema: string, toTable: string, toField: string
      if (parts.length >= 3) {
        toSchema = parts[0]!
        toTable = parts[1]!
        toField = parts[2] ?? "id"
      } else {
        toSchema = schema
        toTable = parts[0] ?? ""
        toField = parts[1] ?? "id"
      }
      return {
        name: col.name.replace(/_id$/, ""),
        type: "belongsTo" as const,
        from_table: table.name,
        from_field: col.name,
        to_schema: toSchema,
        to_table: toTable,
        to_field: toField,
      }
    })

  return { name: table.name, schema, fields, relations }
}

// ─── Auto-layout with dagre ───────────────────────────────────────────────────

const NODE_WIDTH = 240
const NODE_HEADER = 36
const FIELD_HEIGHT = 22
const CROSS_REF_WIDTH = 160
const CROSS_REF_HEIGHT = 28

function getNodeHeight(fields: FieldMeta[]): number {
  return NODE_HEADER + fields.length * FIELD_HEIGHT + 8
}

function applyDagreLayout(
  nodes: Node[],
  edges: Edge[],
  direction: "TB" | "LR" = "LR",
): Node[] {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: direction, nodesep: 40, ranksep: 80 })

  for (const node of nodes) {
    const isCrossRef = node.type === "crossSchemaRef"
    g.setNode(node.id, {
      width: node.measured?.width ?? (isCrossRef ? CROSS_REF_WIDTH : NODE_WIDTH),
      height: node.measured?.height ?? (isCrossRef
        ? CROSS_REF_HEIGHT
        : (node.data as { table?: { fields: FieldMeta[] } }).table
          ? getNodeHeight((node.data as { table: { fields: FieldMeta[] } }).table.fields)
          : 200),
    })
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  return nodes.map(node => {
    const pos = g.node(node.id)
    const w = node.measured?.width ?? NODE_WIDTH
    const h = node.measured?.height ?? 200
    return { ...node, position: { x: pos.x - w / 2, y: pos.y - h / 2 } }
  })
}

// ─── Table node ───────────────────────────────────────────────────────────────

interface TableNodeData {
  table: TableMeta
  [key: string]: unknown
}

function TableNode({ data }: NodeProps<Node<TableNodeData>>) {
  const { table } = data
  return (
    <div
      className="rounded-lg border border-border bg-card shadow-md overflow-hidden"
      style={{ minWidth: NODE_WIDTH, fontSize: 12 }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-accent/80 border-b border-border">
        <span className="font-semibold text-foreground truncate">{table.name}</span>
        <span className="ml-auto text-[10px] text-muted-foreground shrink-0">{table.schema}</span>
      </div>

      {/* Fields */}
      {table.fields.map((field, i) => (
        <div
          key={field.name}
          className={cn(
            "flex items-center gap-2 px-3",
            i < table.fields.length - 1 && "border-b border-border/40",
          )}
          style={{ height: FIELD_HEIGHT }}
        >
          {/* Source handle for FK edges leaving this field */}
          {field.is_foreign_key && (
            <Handle
              type="source"
              position={Position.Right}
              id={`${table.name}-${field.name}-src`}
              style={{ top: NODE_HEADER + i * FIELD_HEIGHT + FIELD_HEIGHT / 2 }}
            />
          )}
          {/* Target handle for FK edges arriving at this field */}
          {field.is_primary && (
            <Handle
              type="target"
              position={Position.Left}
              id={`${table.name}-${field.name}-tgt`}
              style={{ top: NODE_HEADER + i * FIELD_HEIGHT + FIELD_HEIGHT / 2 }}
            />
          )}

          <span className={cn(
            "w-6 text-[10px] shrink-0",
            field.is_primary ? "text-amber-400 font-bold" : field.is_foreign_key ? "text-blue-400" : "text-muted-foreground/40"
          )}>
            {field.is_primary ? "PK" : field.is_foreign_key ? "FK" : ""}
          </span>
          <span className={cn(
            "truncate flex-1",
            field.is_primary ? "text-foreground font-medium" : "text-foreground/80"
          )}>
            {field.name}
          </span>
          <span className="text-[10px] text-muted-foreground shrink-0">{field.type}{field.nullable ? "?" : ""}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Cross-schema reference node (ghost node for external FKs) ───────────────

interface CrossSchemaRefNodeData {
  label: string   // e.g. "auth.users.id"
  [key: string]: unknown
}

function CrossSchemaRefNode({ data }: NodeProps<Node<CrossSchemaRefNodeData>>) {
  return (
    <div
      className="rounded border border-dashed border-muted-foreground/40 bg-card/80 px-2.5 py-1.5 flex items-center gap-1.5"
      style={{ fontSize: 11 }}
    >
      <Handle type="target" position={Position.Left} />
      <span className="text-muted-foreground/60 select-none">↗</span>
      <span className="font-mono text-muted-foreground">{data.label}</span>
    </div>
  )
}

const nodeTypes = {
  table: TableNode,
  crossSchemaRef: CrossSchemaRefNode,
}

// ─── Build React Flow graph from tables ───────────────────────────────────────

function buildGraph(
  tables: TableMeta[],
  activeSchema: string,
): { nodes: Node[]; edges: Edge[] } {
  const tableNames = new Set(tables.map(t => t.name))

  const nodes: Node[] = tables.map(table => ({
    id: table.name,
    type: "table",
    position: { x: 0, y: 0 },
    data: { table },
    draggable: true,
  }))

  const edges: Edge[] = []
  const seen = new Set<string>()
  const crossSchemaRefs = new Map<string, string>()   // nodeId → label

  for (const table of tables) {
    for (const rel of table.relations) {
      const isCrossSchema = rel.to_schema !== activeSchema
      const key = `${rel.from_table}.${rel.from_field}->${rel.to_schema}.${rel.to_table}.${rel.to_field}`
      if (seen.has(key)) continue
      seen.add(key)

      if (isCrossSchema) {
        const refLabel = `${rel.to_schema}.${rel.to_table}.${rel.to_field}`
        const refNodeId = `__ref__${refLabel}`
        if (!crossSchemaRefs.has(refNodeId)) {
          crossSchemaRefs.set(refNodeId, refLabel)
        }
        edges.push({
          id: key,
          source: rel.from_table,
          sourceHandle: `${rel.from_table}-${rel.from_field}-src`,
          target: refNodeId,
          type: "smoothstep",
          animated: false,
          style: {
            stroke: "hsl(var(--border))",
            strokeWidth: 1.5,
            strokeDasharray: "5 3",
          },
        })
      } else if (tableNames.has(rel.to_table)) {
        edges.push({
          id: key,
          source: rel.from_table,
          sourceHandle: `${rel.from_table}-${rel.from_field}-src`,
          target: rel.to_table,
          targetHandle: `${rel.to_table}-${rel.to_field}-tgt`,
          type: "smoothstep",
          animated: false,
          style: { stroke: "hsl(var(--border))", strokeWidth: 1.5 },
        })
      }
    }
  }

  // Add ghost nodes for cross-schema references
  for (const [id, label] of crossSchemaRefs) {
    nodes.push({
      id,
      type: "crossSchemaRef",
      position: { x: 0, y: 0 },
      data: { label },
      draggable: true,
    })
  }

  return { nodes, edges }
}

// ─── ERD view ─────────────────────────────────────────────────────────────────

function ErdFlow({
  tables,
  activeSchema,
}: {
  tables: TableMeta[]
  activeSchema: string
}): React.ReactElement {
  const { nodes: initialNodes, edges: initialEdges } = useMemo(
    () => buildGraph(tables, activeSchema),
    [tables, activeSchema],
  )

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  // Re-sync when tables or schema changes
  useEffect(() => {
    const { nodes: n, edges: e } = buildGraph(tables, activeSchema)
    const laid = applyDagreLayout(n, e)
    setNodes(laid)
    setEdges(e)
  }, [tables, activeSchema])

  const runLayout = useCallback(() => {
    setNodes(current => applyDagreLayout(current, edges))
  }, [edges])

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.1}
        attributionPosition="bottom-right"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} className="opacity-30" />
        <Controls />
        <MiniMap nodeColor={() => "hsl(var(--accent))"} maskColor="hsl(var(--background) / 0.7)" />
        <Panel position="top-right">
          <Button size="sm" variant="secondary" onClick={runLayout}>
            Auto layout
          </Button>
        </Panel>
      </ReactFlow>
    </div>
  )
}

// ─── Field detail (Fields view) ───────────────────────────────────────────────

function FieldDetailPanel({ field, table }: { field: FieldMeta; table: TableMeta }): React.ReactElement {
  return (
    <Card className="p-4">
      <h4 className="m-0 mb-3">
        <code className="text-primary">{table.name}.{field.name}</code>
      </h4>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">Type</label>
          <code className="text-primary">{field.type}</code>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">Nullable</label>
          <span>{field.nullable ? "Yes" : "No"}</span>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">Default</label>
          <span>{field.default_value ?? <span className="text-zinc-600">none</span>}</span>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">Constraints</label>
          <div className="flex gap-1">
            {field.is_primary ? <Badge variant="indigo">PK</Badge> : null}
            {field.is_unique && !field.is_primary ? <Badge variant="green">UQ</Badge> : null}
            {field.is_indexed ? <Badge variant="blue">IDX</Badge> : null}
          </div>
        </div>
        {field.references ? (
          <div className="col-span-2">
            <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">References</label>
            <code className="text-primary">{field.references}</code>
          </div>
        ) : null}
      </div>
    </Card>
  )
}

// ─── Schema selector ──────────────────────────────────────────────────────────

function SchemaSelector({
  schemas,
  value,
  onChange,
}: {
  schemas: string[]
  value: string
  onChange: (schema: string) => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as globalThis.Node | null)) {
        setOpen(false)
        setSearch("")
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  const filtered = schemas.filter(s =>
    s.toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <div ref={wrapperRef} style={{ position: "relative", minWidth: 160, zIndex: 50 }}>
      {/* Trigger */}
      <button
        onClick={() => { setOpen(o => !o); setSearch("") }}
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 rounded border text-sm font-medium transition-colors w-full",
          "border-border bg-card hover:bg-accent text-foreground",
          open && "border-primary/50 ring-1 ring-primary/30",
        )}
      >
        <span className="text-muted-foreground text-xs shrink-0">schema</span>
        <span className="font-semibold flex-1 text-left truncate">{value}</span>
        <svg
          className={cn("w-3.5 h-3.5 text-muted-foreground shrink-0 transition-transform", open && "rotate-180")}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown — absolutely positioned, escapes parent clip via z-index */}
      {open && (
        <div
          className="rounded-lg border border-border bg-popover shadow-xl"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            minWidth: "100%",
            zIndex: 9999,
            overflow: "hidden",
          }}
        >
          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
            <svg className="w-3.5 h-3.5 text-muted-foreground shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Find schema..."
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 outline-none"
            />
          </div>

          {/* List */}
          <div className="max-h-[240px] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">No schemas found</p>
            ) : (
              filtered.map(s => (
                <button
                  key={s}
                  className={cn(
                    "flex items-center gap-2 w-full px-3 py-2 text-sm text-left transition-colors",
                    s === value
                      ? "text-foreground font-medium"
                      : "text-foreground/80 hover:bg-accent",
                  )}
                  onClick={() => { onChange(s); setOpen(false); setSearch("") }}
                >
                  <span className="flex-1 truncate">{s}</span>
                  {s === value && (
                    <svg className="w-3.5 h-3.5 text-primary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main view ────────────────────────────────────────────────────────────────

export function SchemaView(): React.ReactElement {
  const proxy = useProjectProxy()
  const [activeSchema, setActiveSchema] = useState<string>("public")
  const [viewMode, setViewMode] = useState<"fields" | "erd">("erd")
  const [selectedTable, setSelectedTable] = useState<string>("")
  const [selectedField, setSelectedField] = useState<FieldMeta | null>(null)

  const { data: availableSchemas } = useApiQuery(
    async () => proxy.schemas(),
    [proxy],
  )

  const { data: tableData, loading, error, refetch } = useApiQuery(
    async () => {
      const tables = await proxy.introspect(activeSchema)
      return tables.map(t => mapToTableMeta(t, activeSchema))
    },
    [proxy, activeSchema],
  )
  const tables = tableData ?? []

  useEffect(() => {
    if (tables.length > 0 && !selectedTable) {
      setSelectedTable(tables[0]?.name ?? "")
    }
  }, [tables])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    )
  }

  if (error) return <ErrorBanner message={error} onRetry={refetch} />

  if (tables.length === 0) {
    return (
      <EmptyState
        title="No tables found"
        description="Push your schema to see it here."
      />
    )
  }

  const currentTable = tables.find(t => t.name === selectedTable) ?? null

  return (
    <div className="flex flex-col h-full gap-0" style={{ overflow: "visible" }}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-3 flex-shrink-0" style={{ overflow: "visible", position: "relative", zIndex: 50 }}>
        {/* Schema selector */}
        <SchemaSelector
          schemas={availableSchemas ?? ["public"]}
          value={activeSchema}
          onChange={s => { setActiveSchema(s); setSelectedTable(""); setSelectedField(null) }}
        />

        <div className="flex gap-2 ml-auto">
          <Button
            variant={viewMode === "fields" ? "primary" : "secondary"}
            size="sm"
            onClick={() => setViewMode("fields")}
          >
            Fields
          </Button>
          <Button
            variant={viewMode === "erd" ? "primary" : "secondary"}
            size="sm"
            onClick={() => setViewMode("erd")}
          >
            ERD Diagram
          </Button>
        </div>
      </div>

      {/* Content */}
      {viewMode === "erd" ? (
        <div className="flex-1 min-h-0 rounded-lg border border-border overflow-hidden">
          <ErdFlow tables={tables} activeSchema={activeSchema} />
        </div>
      ) : (
        /* Fields view — table list + detail */
        <div className="flex gap-4 flex-1 min-h-0">
          {/* Table list */}
          <div className="w-[200px] flex-shrink-0 overflow-y-auto">
            <Card className="p-1 flex flex-col gap-0.5">
              {tables.map(t => (
                <button
                  key={t.name}
                  className={cn(
                    "flex items-center gap-2 w-full px-3 py-2 text-sm rounded-md transition-colors text-left",
                    t.name === selectedTable
                      ? "bg-accent text-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                  onClick={() => { setSelectedTable(t.name); setSelectedField(null) }}
                >
                  {t.name}
                </button>
              ))}
            </Card>
          </div>

          {/* Table detail */}
          <div className="flex-1 min-w-0 overflow-y-auto">
            {currentTable ? (
              <div className="flex gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-3">
                    <h3 className="m-0 text-base">{currentTable.name}</h3>
                    <code className="text-xs text-muted-foreground">{currentTable.schema}.{currentTable.name}</code>
                  </div>
                  <Card className="overflow-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border">
                          <Th>Field</Th><Th>Type</Th><Th>Nullable</Th><Th>Default</Th><Th>Constraints</Th><Th>References</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {currentTable.fields.map(f => (
                          <tr
                            key={f.name}
                            className={cn(
                              "border-b border-border hover:bg-accent/50 cursor-pointer",
                              selectedField?.name === f.name && "bg-primary/5",
                            )}
                            onClick={() => setSelectedField(f)}
                          >
                            <Td className={f.is_primary ? "font-semibold" : ""}>{f.name}</Td>
                            <Td><code className="text-primary text-xs">{f.type}</code></Td>
                            <Td>{f.nullable ? "yes" : "no"}</Td>
                            <Td className="text-xs text-muted-foreground">{f.default_value ?? "—"}</Td>
                            <Td>
                              <div className="flex gap-1">
                                {f.is_primary ? <Badge variant="indigo">PK</Badge> : null}
                                {f.is_unique && !f.is_primary ? <Badge variant="green">UQ</Badge> : null}
                                {f.is_indexed ? <Badge variant="blue">IDX</Badge> : null}
                              </div>
                            </Td>
                            <Td className="text-xs text-muted-foreground">{f.references ?? "—"}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                </div>
                {selectedField ? (
                  <div className="w-[280px] flex-shrink-0">
                    <FieldDetailPanel field={selectedField} table={currentTable} />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
