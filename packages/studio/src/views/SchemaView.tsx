import React, { useState } from "react"
import { useStudioClient } from "../StudioApp.js"
import { Badge, Card, Th, Td } from "../components/ui.js"

interface FieldMeta {
  name: string
  type: string
  nullable: boolean
  default_value: string | null
  is_primary: boolean
  is_unique: boolean
  references: string | null
}

interface ModelMeta {
  name: string
  table_name: string
  fields: FieldMeta[]
}

const mockModels: ModelMeta[] = [
  {
    name: "User",
    table_name: "users",
    fields: [
      { name: "id", type: "uuid", nullable: false, default_value: "gen_random_uuid()", is_primary: true, is_unique: true, references: null },
      { name: "email", type: "text", nullable: false, default_value: null, is_primary: false, is_unique: true, references: null },
      { name: "name", type: "text", nullable: false, default_value: null, is_primary: false, is_unique: false, references: null },
      { name: "created_at", type: "timestamptz", nullable: false, default_value: "now()", is_primary: false, is_unique: false, references: null },
      { name: "updated_at", type: "timestamptz", nullable: false, default_value: "now()", is_primary: false, is_unique: false, references: null },
    ],
  },
  {
    name: "Post",
    table_name: "posts",
    fields: [
      { name: "id", type: "uuid", nullable: false, default_value: "gen_random_uuid()", is_primary: true, is_unique: true, references: null },
      { name: "title", type: "text", nullable: false, default_value: null, is_primary: false, is_unique: false, references: null },
      { name: "slug", type: "text", nullable: false, default_value: null, is_primary: false, is_unique: true, references: null },
      { name: "content", type: "text", nullable: true, default_value: null, is_primary: false, is_unique: false, references: null },
      { name: "author_id", type: "uuid", nullable: false, default_value: null, is_primary: false, is_unique: false, references: "users.id" },
      { name: "status", type: "text", nullable: false, default_value: "'draft'", is_primary: false, is_unique: false, references: null },
      { name: "created_at", type: "timestamptz", nullable: false, default_value: "now()", is_primary: false, is_unique: false, references: null },
      { name: "updated_at", type: "timestamptz", nullable: false, default_value: "now()", is_primary: false, is_unique: false, references: null },
    ],
  },
  {
    name: "Tag",
    table_name: "tags",
    fields: [
      { name: "id", type: "uuid", nullable: false, default_value: "gen_random_uuid()", is_primary: true, is_unique: true, references: null },
      { name: "name", type: "text", nullable: false, default_value: null, is_primary: false, is_unique: true, references: null },
      { name: "slug", type: "text", nullable: false, default_value: null, is_primary: false, is_unique: true, references: null },
    ],
  },
]

export function SchemaView(): React.ReactElement {
  const [models] = useState<ModelMeta[]>(mockModels)
  const [selected, setSelected] = useState<string>(mockModels[0]?.name ?? "")

  const current = models.find((m) => m.name === selected)

  return (
    <div className="grid grid-cols-[220px_1fr] gap-4">
      {/* Model list */}
      <Card className="p-2 flex flex-col gap-0.5">
        {models.map((m) => (
          <button
            key={m.name}
            className={`flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground rounded-md transition-colors${m.name === selected ? " bg-accent text-foreground font-medium" : ""}`}
            onClick={() => setSelected(m.name)}
          >
            {m.name}
            <span className="ml-auto text-zinc-600 text-[0.7rem]">{m.table_name}</span>
          </button>
        ))}
      </Card>

      {/* Field list */}
      {current ? (
        <Card className="p-4">
          <h3>{current.name} <span className="text-zinc-600 font-normal text-[0.8rem]">({current.table_name})</span></h3>
          <Card className="overflow-auto mt-3">
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
                  <tr key={f.name} className="border-b border-border hover:bg-accent/50">
                    <Td className={f.is_primary ? "font-semibold" : ""}>{f.name}</Td>
                    <Td><code className="text-primary text-xs">{f.type}</code></Td>
                    <Td>{f.nullable ? "yes" : "no"}</Td>
                    <Td className="text-xs text-muted-foreground">{f.default_value ?? "\u2014"}</Td>
                    <Td>
                      {f.is_primary ? <Badge variant="indigo">PK</Badge> : null}
                      {f.is_unique && !f.is_primary ? <Badge variant="green">UQ</Badge> : null}
                    </Td>
                    <Td className="text-xs text-muted-foreground">{f.references ?? "\u2014"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </Card>
      ) : (
        <div className="text-muted-foreground text-sm">Select a model to view its fields</div>
      )}
    </div>
  )
}
