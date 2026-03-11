import React, { useState } from "react"
import { useStudioClient } from "../StudioApp.js"
import { Badge, Button, Card, CodeBlock, Th, Td } from "../components/ui.js"

interface Migration {
  id: string
  name: string
  applied_at: string
  sql_up: string
  sql_down: string | null
  risk_level: "safe" | "cautious" | "destructive"
  checksum: string
}

const riskVariant: Record<Migration["risk_level"], "green" | "yellow" | "red"> = {
  safe: "green",
  cautious: "yellow",
  destructive: "red",
}

const mockMigrations: Migration[] = [
  {
    id: "001",
    name: "create_users",
    applied_at: "2026-01-10T08:00:00Z",
    sql_up: `CREATE TABLE users (\n  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n  email TEXT NOT NULL UNIQUE,\n  name TEXT NOT NULL,\n  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),\n  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()\n);`,
    sql_down: "DROP TABLE users;",
    risk_level: "safe",
    checksum: "a1b2c3d4",
  },
  {
    id: "002",
    name: "create_posts",
    applied_at: "2026-01-12T10:00:00Z",
    sql_up: `CREATE TABLE posts (\n  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n  title TEXT NOT NULL,\n  slug TEXT NOT NULL UNIQUE,\n  content TEXT,\n  author_id UUID NOT NULL REFERENCES users(id),\n  status TEXT NOT NULL DEFAULT 'draft',\n  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),\n  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()\n);`,
    sql_down: "DROP TABLE posts;",
    risk_level: "safe",
    checksum: "e5f6g7h8",
  },
  {
    id: "003",
    name: "add_posts_rls",
    applied_at: "2026-01-15T14:30:00Z",
    sql_up: `ALTER TABLE posts ENABLE ROW LEVEL SECURITY;\nALTER TABLE posts FORCE ROW LEVEL SECURITY;\n\nCREATE POLICY posts_read ON posts FOR SELECT USING (true);\nCREATE POLICY posts_insert ON posts FOR INSERT WITH CHECK (auth.uid() = author_id);`,
    sql_down: `DROP POLICY posts_insert ON posts;\nDROP POLICY posts_read ON posts;\nALTER TABLE posts DISABLE ROW LEVEL SECURITY;`,
    risk_level: "safe",
    checksum: "i9j0k1l2",
  },
  {
    id: "004",
    name: "add_tags_and_post_tags",
    applied_at: "2026-02-01T09:00:00Z",
    sql_up: `CREATE TABLE tags (\n  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n  name TEXT NOT NULL UNIQUE,\n  slug TEXT NOT NULL UNIQUE\n);\n\nCREATE TABLE post_tags (\n  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,\n  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,\n  PRIMARY KEY (post_id, tag_id)\n);`,
    sql_down: "DROP TABLE post_tags;\nDROP TABLE tags;",
    risk_level: "safe",
    checksum: "m3n4o5p6",
  },
]

export function MigrationHistory(): React.ReactElement {
  const client = useStudioClient()
  const [migrations] = useState<Migration[]>(mockMigrations)
  const [selected, setSelected] = useState<Migration | null>(null)
  const [confirmRollback, setConfirmRollback] = useState(false)

  return (
    <>
      <Card className="overflow-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <Th>#</Th>
              <Th>Name</Th>
              <Th>Applied</Th>
              <Th>Risk</Th>
              <Th>Checksum</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {migrations.map((m) => (
              <tr key={m.id} className="border-b border-border hover:bg-accent/50">
                <Td className="font-mono text-muted-foreground">{m.id}</Td>
                <Td className="font-medium">{m.name}</Td>
                <Td className="text-xs text-muted-foreground">{new Date(m.applied_at).toLocaleDateString()}</Td>
                <Td><Badge variant={riskVariant[m.risk_level]}>{m.risk_level}</Badge></Td>
                <Td className="font-mono text-[0.7rem] text-zinc-600">{m.checksum}</Td>
                <Td>
                  <Button onClick={() => { setSelected(m); setConfirmRollback(false) }}>View SQL</Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Detail panel */}
      {selected ? (
        <Card className="p-4 mt-4">
          <div className="flex justify-between items-center mb-3">
            <h3 className="m-0">
              {selected.name} <span className="font-normal text-zinc-600">#{selected.id}</span>
            </h3>
            <Button onClick={() => setSelected(null)}>Close</Button>
          </div>

          <CodeBlock>{selected.sql_up}</CodeBlock>

          {selected.sql_down ? (
            <div className="mt-4">
              {!confirmRollback ? (
                <Button variant="destructive" onClick={() => setConfirmRollback(true)}>
                  Rollback this migration
                </Button>
              ) : (
                <div className="flex gap-2 items-center">
                  <span className="text-red-400 text-xs">Are you sure? This will run the rollback SQL.</span>
                  <Button variant="destructive">Confirm Rollback</Button>
                  <Button onClick={() => setConfirmRollback(false)}>Cancel</Button>
                </div>
              )}
            </div>
          ) : null}
        </Card>
      ) : null}
    </>
  )
}
