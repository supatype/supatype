import React, { useState, useMemo, useCallback } from "react"
import { useStudioClient } from "../StudioApp.js"
import { cn } from "../lib/utils.js"
import { Badge, Button, Card, CodeBlock, Input, Select, Th, Td } from "../components/ui.js"

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
}

interface RelationMeta {
  name: string
  type: "belongsTo" | "hasMany" | "manyToMany"
  from_model: string
  from_field: string
  to_model: string
  to_field: string
  through_table?: string
}

interface ModelMeta {
  name: string
  table_name: string
  fields: FieldMeta[]
  relations: RelationMeta[]
  timestamps: boolean
  publishable: boolean
  softDelete: boolean
}

type SupportedFieldType =
  | "text" | "integer" | "bigint" | "boolean" | "uuid" | "timestamptz"
  | "timestamp" | "date" | "float" | "decimal" | "jsonb" | "json"
  | "serial" | "bytea" | "inet" | "cidr" | "macaddr"

// ─── Mock Data ────────────────────────────────────────────────────────────────

const mockModels: ModelMeta[] = [
  {
    name: "User",
    table_name: "users",
    timestamps: true,
    publishable: false,
    softDelete: false,
    fields: [
      { name: "id", type: "uuid", nullable: false, default_value: "gen_random_uuid()", is_primary: true, is_unique: true, is_indexed: true, references: null },
      { name: "email", type: "text", nullable: false, default_value: null, is_primary: false, is_unique: true, is_indexed: true, references: null },
      { name: "name", type: "text", nullable: false, default_value: null, is_primary: false, is_unique: false, is_indexed: false, references: null },
      { name: "avatar_url", type: "text", nullable: true, default_value: null, is_primary: false, is_unique: false, is_indexed: false, references: null },
      { name: "created_at", type: "timestamptz", nullable: false, default_value: "now()", is_primary: false, is_unique: false, is_indexed: false, references: null },
      { name: "updated_at", type: "timestamptz", nullable: false, default_value: "now()", is_primary: false, is_unique: false, is_indexed: false, references: null },
    ],
    relations: [],
  },
  {
    name: "Post",
    table_name: "posts",
    timestamps: true,
    publishable: true,
    softDelete: false,
    fields: [
      { name: "id", type: "uuid", nullable: false, default_value: "gen_random_uuid()", is_primary: true, is_unique: true, is_indexed: true, references: null },
      { name: "title", type: "text", nullable: false, default_value: null, is_primary: false, is_unique: false, is_indexed: false, references: null },
      { name: "slug", type: "text", nullable: false, default_value: null, is_primary: false, is_unique: true, is_indexed: true, references: null },
      { name: "content", type: "text", nullable: true, default_value: null, is_primary: false, is_unique: false, is_indexed: false, references: null },
      { name: "author_id", type: "uuid", nullable: false, default_value: null, is_primary: false, is_unique: false, is_indexed: true, references: "users.id" },
      { name: "status", type: "text", nullable: false, default_value: "'draft'", is_primary: false, is_unique: false, is_indexed: true, references: null },
      { name: "metadata", type: "jsonb", nullable: true, default_value: null, is_primary: false, is_unique: false, is_indexed: false, references: null },
      { name: "created_at", type: "timestamptz", nullable: false, default_value: "now()", is_primary: false, is_unique: false, is_indexed: false, references: null },
      { name: "updated_at", type: "timestamptz", nullable: false, default_value: "now()", is_primary: false, is_unique: false, is_indexed: false, references: null },
    ],
    relations: [
      { name: "author", type: "belongsTo", from_model: "Post", from_field: "author_id", to_model: "User", to_field: "id" },
      { name: "tags", type: "manyToMany", from_model: "Post", from_field: "id", to_model: "Tag", to_field: "id", through_table: "post_tags" },
    ],
  },
  {
    name: "Tag",
    table_name: "tags",
    timestamps: false,
    publishable: false,
    softDelete: false,
    fields: [
      { name: "id", type: "uuid", nullable: false, default_value: "gen_random_uuid()", is_primary: true, is_unique: true, is_indexed: true, references: null },
      { name: "name", type: "text", nullable: false, default_value: null, is_primary: false, is_unique: true, is_indexed: true, references: null },
      { name: "slug", type: "text", nullable: false, default_value: null, is_primary: false, is_unique: true, is_indexed: true, references: null },
    ],
    relations: [
      { name: "posts", type: "manyToMany", from_model: "Tag", from_field: "id", to_model: "Post", to_field: "id", through_table: "post_tags" },
    ],
  },
]

const FIELD_TYPES: SupportedFieldType[] = [
  "text", "integer", "bigint", "boolean", "uuid", "timestamptz",
  "timestamp", "date", "float", "decimal", "jsonb", "json", "serial", "bytea",
]

// ─── ERD Diagram (simplified) ─────────────────────────────────────────────────

function ErdDiagram({ models }: { models: ModelMeta[] }): React.ReactElement {
  // Collect all relations across all models
  const allRelations = useMemo(() => {
    const seen = new Set<string>()
    const relations: RelationMeta[] = []
    for (const model of models) {
      for (const rel of model.relations) {
        const key = [rel.from_model, rel.to_model].sort().join("-") + rel.name
        if (!seen.has(key)) {
          seen.add(key)
          relations.push(rel)
        }
      }
    }
    return relations
  }, [models])

  // Layout: position models in a grid
  const cols = Math.ceil(Math.sqrt(models.length))
  const modelPositions = useMemo(() => {
    const positions: Record<string, { x: number; y: number }> = {}
    models.forEach((m, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      positions[m.name] = { x: col * 280 + 20, y: row * 240 + 20 }
    })
    return positions
  }, [models, cols])

  const svgWidth = (cols * 280) + 40
  const svgHeight = (Math.ceil(models.length / cols) * 240) + 40

  return (
    <Card className="overflow-auto bg-background">
      <svg width={svgWidth} height={svgHeight} className="min-w-full">
        {/* Relation lines */}
        {allRelations.map((rel, i) => {
          const fromPos = modelPositions[rel.from_model]
          const toPos = modelPositions[rel.to_model]
          if (!fromPos || !toPos) return null
          const x1 = fromPos.x + 120
          const y1 = fromPos.y + 80
          const x2 = toPos.x + 120
          const y2 = toPos.y + 80
          const midX = (x1 + x2) / 2
          const midY = (y1 + y2) / 2

          const relLabel = rel.type === "belongsTo" ? "1:N" : rel.type === "hasMany" ? "N:1" : "M:N"

          return (
            <g key={i}>
              <line
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke="currentColor"
                strokeOpacity={0.3}
                strokeWidth={1.5}
                strokeDasharray={rel.type === "manyToMany" ? "4,4" : undefined}
              />
              <text
                x={midX}
                y={midY - 6}
                textAnchor="middle"
                className="fill-muted-foreground text-[0.6rem]"
              >
                {rel.name} ({relLabel})
              </text>
            </g>
          )
        })}

        {/* Model boxes */}
        {models.map((model) => {
          const pos = modelPositions[model.name]
          if (!pos) return null
          const boxHeight = 30 + model.fields.length * 18 + 10
          return (
            <g key={model.name}>
              <rect
                x={pos.x}
                y={pos.y}
                width={240}
                height={boxHeight}
                rx={6}
                className="fill-card stroke-border"
                strokeWidth={1}
              />
              {/* Model header */}
              <rect
                x={pos.x}
                y={pos.y}
                width={240}
                height={28}
                rx={6}
                className="fill-accent"
              />
              <text
                x={pos.x + 12}
                y={pos.y + 18}
                className="fill-foreground text-[0.75rem] font-semibold"
              >
                {model.name}
              </text>
              <text
                x={pos.x + 228}
                y={pos.y + 18}
                textAnchor="end"
                className="fill-muted-foreground text-[0.55rem]"
              >
                {model.table_name}
              </text>
              {/* Fields */}
              {model.fields.map((field, fi) => {
                const fieldY = pos.y + 38 + fi * 18
                return (
                  <g key={field.name}>
                    <text
                      x={pos.x + 12}
                      y={fieldY + 10}
                      className={cn("text-[0.65rem]", field.is_primary ? "fill-primary font-semibold" : "fill-foreground")}
                    >
                      {field.is_primary ? "PK " : field.references ? "FK " : "   "}
                      {field.name}
                    </text>
                    <text
                      x={pos.x + 228}
                      y={fieldY + 10}
                      textAnchor="end"
                      className="fill-muted-foreground text-[0.6rem]"
                    >
                      {field.type}{field.nullable ? "?" : ""}
                    </text>
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
    </Card>
  )
}

// ─── Field Form (read-only info in v1) ────────────────────────────────────────

function FieldDetailPanel({ field, model }: { field: FieldMeta; model: ModelMeta }): React.ReactElement {
  return (
    <Card className="p-4">
      <h4 className="m-0 mb-3">
        <code className="text-primary">{model.name}.{field.name}</code>
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
      <div className="mt-3 p-2 bg-accent/30 rounded text-xs text-muted-foreground">
        Read-only in v1. Modify your TypeScript schema to change field definitions.
      </div>
    </Card>
  )
}

// ─── Relation Form (read-only) ────────────────────────────────────────────────

function RelationDetailPanel({ relation }: { relation: RelationMeta }): React.ReactElement {
  const typeLabel = relation.type === "belongsTo" ? "Belongs To" : relation.type === "hasMany" ? "Has Many" : "Many to Many"
  return (
    <Card className="p-4">
      <h4 className="m-0 mb-3">
        Relation: <code className="text-primary">{relation.name}</code>
      </h4>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">Type</label>
          <Badge variant="indigo">{typeLabel}</Badge>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">From</label>
          <code>{relation.from_model}.{relation.from_field}</code>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">To</label>
          <code>{relation.to_model}.{relation.to_field}</code>
        </div>
        {relation.through_table ? (
          <div>
            <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">Through</label>
            <code>{relation.through_table}</code>
          </div>
        ) : null}
      </div>
    </Card>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function SchemaView(): React.ReactElement {
  const [models] = useState<ModelMeta[]>(mockModels)
  const [selected, setSelected] = useState<string>(mockModels[0]?.name ?? "")
  const [modelSearch, setModelSearch] = useState("")
  const [viewMode, setViewMode] = useState<"table" | "erd">("table")
  const [selectedField, setSelectedField] = useState<FieldMeta | null>(null)
  const [selectedRelation, setSelectedRelation] = useState<RelationMeta | null>(null)

  const current = models.find((m) => m.name === selected) ?? null

  const filteredModels = modelSearch
    ? models.filter((m) =>
        m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
        m.table_name.toLowerCase().includes(modelSearch.toLowerCase())
      )
    : models

  return (
    <div className="flex gap-4 h-full">
      {/* Model list sidebar */}
      <div className="w-[240px] flex-shrink-0">
        <Input
          placeholder="Search models..."
          value={modelSearch}
          onChange={(e) => setModelSearch(e.target.value)}
          className="mb-2"
        />
        <Card className="p-1.5 flex flex-col gap-0.5 max-h-[calc(100vh-200px)] overflow-y-auto">
          {filteredModels.map((m) => (
            <button
              key={m.name}
              className={cn(
                "flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground rounded-md transition-colors",
                m.name === selected && "bg-accent text-foreground font-medium"
              )}
              onClick={() => { setSelected(m.name); setSelectedField(null); setSelectedRelation(null) }}
            >
              <span>{m.name}</span>
              <span className="ml-auto text-zinc-600 text-[0.7rem]">{m.table_name}</span>
            </button>
          ))}
        </Card>
      </div>

      {/* Main view */}
      <div className="flex-1 min-w-0">
        {/* View mode toggle */}
        <div className="flex gap-2 mb-4">
          <Button
            variant={viewMode === "table" ? "primary" : "secondary"}
            size="sm"
            onClick={() => setViewMode("table")}
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

        {viewMode === "erd" ? (
          <ErdDiagram models={models} />
        ) : current ? (
          <div className="flex gap-4">
            {/* Fields + Relations */}
            <div className="flex-1 min-w-0">
              {/* Model header */}
              <div className="flex items-center gap-3 mb-3">
                <h3 className="m-0">{current.name}</h3>
                <code className="text-zinc-600 text-sm">{current.table_name}</code>
                <div className="flex gap-1 ml-auto">
                  {current.timestamps ? <Badge variant="blue">timestamps</Badge> : null}
                  {current.publishable ? <Badge variant="green">publishable</Badge> : null}
                  {current.softDelete ? <Badge variant="yellow">soft delete</Badge> : null}
                </div>
              </div>

              {/* Fields table */}
              <Card className="overflow-auto mb-4">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      <Th>Field</Th>
                      <Th>Type</Th>
                      <Th>Nullable</Th>
                      <Th>Default</Th>
                      <Th>Constraints</Th>
                      <Th>References</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.fields.map((f) => (
                      <tr
                        key={f.name}
                        className={cn(
                          "border-b border-border hover:bg-accent/50 cursor-pointer",
                          selectedField?.name === f.name && "bg-primary/5"
                        )}
                        onClick={() => { setSelectedField(f); setSelectedRelation(null) }}
                      >
                        <Td className={f.is_primary ? "font-semibold" : ""}>
                          {f.name}
                        </Td>
                        <Td><code className="text-primary text-xs">{f.type}</code></Td>
                        <Td>{f.nullable ? "yes" : "no"}</Td>
                        <Td className="text-xs text-muted-foreground">{f.default_value ?? "\u2014"}</Td>
                        <Td>
                          <div className="flex gap-1">
                            {f.is_primary ? <Badge variant="indigo">PK</Badge> : null}
                            {f.is_unique && !f.is_primary ? <Badge variant="green">UQ</Badge> : null}
                            {f.is_indexed ? <Badge variant="blue">IDX</Badge> : null}
                          </div>
                        </Td>
                        <Td className="text-xs text-muted-foreground">{f.references ?? "\u2014"}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>

              {/* Relations */}
              {current.relations.length > 0 ? (
                <>
                  <h4 className="text-sm text-muted-foreground mb-2">Relations</h4>
                  <Card className="overflow-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border">
                          <Th>Name</Th>
                          <Th>Type</Th>
                          <Th>Target</Th>
                          <Th>Through</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {current.relations.map((rel) => (
                          <tr
                            key={rel.name}
                            className={cn(
                              "border-b border-border hover:bg-accent/50 cursor-pointer",
                              selectedRelation?.name === rel.name && "bg-primary/5"
                            )}
                            onClick={() => { setSelectedRelation(rel); setSelectedField(null) }}
                          >
                            <Td className="font-medium">{rel.name}</Td>
                            <Td>
                              <Badge variant={
                                rel.type === "belongsTo" ? "indigo" :
                                rel.type === "hasMany" ? "green" : "yellow"
                              }>
                                {rel.type}
                              </Badge>
                            </Td>
                            <Td>
                              <code className="text-primary text-xs">{rel.to_model}.{rel.to_field}</code>
                            </Td>
                            <Td className="text-xs text-muted-foreground">
                              {rel.through_table ?? "\u2014"}
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                </>
              ) : null}
            </div>

            {/* Detail panel */}
            {selectedField ? (
              <div className="w-[300px] flex-shrink-0">
                <FieldDetailPanel field={selectedField} model={current} />
              </div>
            ) : selectedRelation ? (
              <div className="w-[300px] flex-shrink-0">
                <RelationDetailPanel relation={selectedRelation} />
              </div>
            ) : null}
          </div>
        ) : (
          <div className="text-muted-foreground text-sm">Select a model to view its schema</div>
        )}
      </div>
    </div>
  )
}
