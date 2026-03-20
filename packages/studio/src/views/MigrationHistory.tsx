import React, { useState, useMemo } from "react"
import { useStudioClient } from "../StudioApp.js"
import { cn } from "../lib/utils.js"
import { Badge, Button, Card, CodeBlock, Input, Select, Th, Td } from "../components/ui.js"

// ─── Types ────────────────────────────────────────────────────────────────────

type MigrationStatus = "applied" | "rolled_back" | "pending" | "failed"
type RiskLevel = "safe" | "cautious" | "destructive"

interface Migration {
  id: string
  version: number
  name: string
  applied_at: string | null
  rolled_back_at: string | null
  status: MigrationStatus
  sql_up: string
  sql_down: string | null
  risk_level: RiskLevel
  checksum: string
  execution_time_ms: number | null
  applied_by: string | null
}

// ─── Mock Data ────────────────────────────────────────────────────────────────

const riskVariant: Record<RiskLevel, "green" | "yellow" | "red"> = {
  safe: "green",
  cautious: "yellow",
  destructive: "red",
}

const statusVariant: Record<MigrationStatus, "green" | "yellow" | "red" | "blue"> = {
  applied: "green",
  rolled_back: "yellow",
  pending: "blue",
  failed: "red",
}

const mockMigrations: Migration[] = [
  {
    id: "m001",
    version: 1,
    name: "create_users",
    applied_at: "2026-01-10T08:00:00Z",
    rolled_back_at: null,
    status: "applied",
    sql_up: `CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_email ON users (email);

-- Enable RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;`,
    sql_down: `DROP TABLE IF EXISTS users CASCADE;`,
    risk_level: "safe",
    checksum: "a1b2c3d4e5f6",
    execution_time_ms: 42,
    applied_by: "CLI",
  },
  {
    id: "m002",
    version: 2,
    name: "create_posts",
    applied_at: "2026-01-12T10:00:00Z",
    rolled_back_at: null,
    status: "applied",
    sql_up: `CREATE TABLE posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  content TEXT,
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_posts_author ON posts (author_id);
CREATE INDEX idx_posts_status ON posts (status);
CREATE INDEX idx_posts_slug ON posts (slug);`,
    sql_down: `DROP TABLE IF EXISTS posts CASCADE;`,
    risk_level: "safe",
    checksum: "f7g8h9i0j1k2",
    execution_time_ms: 38,
    applied_by: "CLI",
  },
  {
    id: "m003",
    version: 3,
    name: "add_posts_rls",
    applied_at: "2026-01-15T14:30:00Z",
    rolled_back_at: null,
    status: "applied",
    sql_up: `ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts FORCE ROW LEVEL SECURITY;

CREATE POLICY posts_read ON posts
  FOR SELECT USING (true);

CREATE POLICY posts_insert ON posts
  FOR INSERT WITH CHECK (auth.uid() = author_id);

CREATE POLICY posts_update ON posts
  FOR UPDATE USING (auth.uid() = author_id)
  WITH CHECK (auth.uid() = author_id);

CREATE POLICY posts_delete ON posts
  FOR DELETE USING (auth.uid() = author_id);`,
    sql_down: `DROP POLICY IF EXISTS posts_delete ON posts;
DROP POLICY IF EXISTS posts_update ON posts;
DROP POLICY IF EXISTS posts_insert ON posts;
DROP POLICY IF EXISTS posts_read ON posts;
ALTER TABLE posts DISABLE ROW LEVEL SECURITY;`,
    risk_level: "safe",
    checksum: "l3m4n5o6p7q8",
    execution_time_ms: 15,
    applied_by: "CLI",
  },
  {
    id: "m004",
    version: 4,
    name: "add_tags_and_post_tags",
    applied_at: "2026-02-01T09:00:00Z",
    rolled_back_at: null,
    status: "applied",
    sql_up: `CREATE TABLE tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE post_tags (
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);

CREATE INDEX idx_post_tags_tag ON post_tags (tag_id);`,
    sql_down: `DROP TABLE IF EXISTS post_tags CASCADE;
DROP TABLE IF EXISTS tags CASCADE;`,
    risk_level: "safe",
    checksum: "r9s0t1u2v3w4",
    execution_time_ms: 28,
    applied_by: "CLI",
  },
  {
    id: "m005",
    version: 5,
    name: "add_user_bio_column",
    applied_at: "2026-02-15T11:00:00Z",
    rolled_back_at: null,
    status: "applied",
    sql_up: `ALTER TABLE users ADD COLUMN bio TEXT;`,
    sql_down: `ALTER TABLE users DROP COLUMN IF EXISTS bio;`,
    risk_level: "safe",
    checksum: "x5y6z7a8b9c0",
    execution_time_ms: 8,
    applied_by: "Studio",
  },
  {
    id: "m006",
    version: 6,
    name: "rename_status_to_publish_state",
    applied_at: "2026-03-01T15:00:00Z",
    rolled_back_at: null,
    status: "applied",
    sql_up: `ALTER TABLE posts RENAME COLUMN status TO publish_state;`,
    sql_down: `ALTER TABLE posts RENAME COLUMN publish_state TO status;`,
    risk_level: "cautious",
    checksum: "d1e2f3g4h5i6",
    execution_time_ms: 5,
    applied_by: "CLI",
  },
  {
    id: "m007",
    version: 7,
    name: "drop_unused_index",
    applied_at: null,
    rolled_back_at: null,
    status: "pending",
    sql_up: `DROP INDEX IF EXISTS idx_posts_status;`,
    sql_down: `CREATE INDEX idx_posts_status ON posts (publish_state);`,
    risk_level: "destructive",
    checksum: "j7k8l9m0n1o2",
    execution_time_ms: null,
    applied_by: null,
  },
]

// ─── SQL Diff View ────────────────────────────────────────────────────────────

function SqlDiffView({ sqlUp, sqlDown }: { sqlUp: string; sqlDown: string | null }): React.ReactElement {
  const [showRollback, setShowRollback] = useState(false)

  return (
    <div>
      <div className="flex gap-2 mb-2">
        <Button
          size="xs"
          variant={!showRollback ? "primary" : "secondary"}
          onClick={() => setShowRollback(false)}
        >
          Up (Apply)
        </Button>
        {sqlDown ? (
          <Button
            size="xs"
            variant={showRollback ? "primary" : "secondary"}
            onClick={() => setShowRollback(true)}
          >
            Down (Rollback)
          </Button>
        ) : null}
      </div>

      <div className="font-mono text-sm">
        {showRollback && sqlDown ? (
          <div className="rounded-md border border-border bg-background p-4 overflow-x-auto whitespace-pre">
            {sqlDown.split("\n").map((line, i) => (
              <div key={i} className={cn(
                "leading-relaxed",
                line.startsWith("DROP") ? "text-red-400 bg-red-500/10" :
                line.startsWith("ALTER") ? "text-yellow-400 bg-yellow-500/10" :
                "text-foreground"
              )}>
                <span className="text-zinc-600 text-xs inline-block w-8 text-right mr-3 select-none">{i + 1}</span>
                {line}
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-border bg-background p-4 overflow-x-auto whitespace-pre">
            {sqlUp.split("\n").map((line, i) => (
              <div key={i} className={cn(
                "leading-relaxed",
                line.startsWith("CREATE") ? "text-green-400 bg-green-500/10" :
                line.startsWith("ALTER") ? "text-yellow-400 bg-yellow-500/10" :
                line.startsWith("DROP") ? "text-red-400 bg-red-500/10" :
                line.startsWith("--") ? "text-zinc-600" :
                "text-foreground"
              )}>
                <span className="text-zinc-600 text-xs inline-block w-8 text-right mr-3 select-none">{i + 1}</span>
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function MigrationHistory(): React.ReactElement {
  const client = useStudioClient()

  const [migrations] = useState<Migration[]>(mockMigrations)
  const [selected, setSelected] = useState<Migration | null>(null)
  const [confirmRollback, setConfirmRollback] = useState(false)

  // Filters
  const [search, setSearch] = useState("")
  const [filterStatus, setFilterStatus] = useState("all")
  const [filterRisk, setFilterRisk] = useState("all")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")

  // Filtered migrations
  const filtered = useMemo(() => {
    return migrations.filter((m) => {
      if (search && !m.name.toLowerCase().includes(search.toLowerCase()) && !m.id.includes(search)) return false
      if (filterStatus !== "all" && m.status !== filterStatus) return false
      if (filterRisk !== "all" && m.risk_level !== filterRisk) return false
      if (dateFrom && m.applied_at && new Date(m.applied_at) < new Date(dateFrom)) return false
      if (dateTo && m.applied_at && new Date(m.applied_at) > new Date(dateTo + "T23:59:59Z")) return false
      return true
    })
  }, [migrations, search, filterStatus, filterRisk, dateFrom, dateTo])

  return (
    <>
      {/* Filters */}
      <div className="flex gap-2 mb-4 flex-wrap">
        <Input
          className="w-[250px]"
          placeholder="Search by name or version..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select className="w-[130px]" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="all">All status</option>
          <option value="applied">Applied</option>
          <option value="rolled_back">Rolled back</option>
          <option value="pending">Pending</option>
          <option value="failed">Failed</option>
        </Select>
        <Select className="w-[130px]" value={filterRisk} onChange={(e) => setFilterRisk(e.target.value)}>
          <option value="all">All risk</option>
          <option value="safe">Safe</option>
          <option value="cautious">Cautious</option>
          <option value="destructive">Destructive</option>
        </Select>
        <div className="flex items-center gap-1">
          <label className="text-xs text-muted-foreground">From:</label>
          <Input
            type="date"
            className="w-[140px]"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1">
          <label className="text-xs text-muted-foreground">To:</label>
          <Input
            type="date"
            className="w-[140px]"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </div>
      </div>

      {/* Migration list */}
      <Card className="overflow-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <Th>Version</Th>
              <Th>Name</Th>
              <Th>Status</Th>
              <Th>Applied</Th>
              <Th>Risk</Th>
              <Th>Duration</Th>
              <Th>Applied By</Th>
              <Th>Checksum</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => (
              <tr
                key={m.id}
                className={cn(
                  "border-b border-border hover:bg-accent/50 cursor-pointer",
                  selected?.id === m.id && "bg-primary/5"
                )}
                onClick={() => { setSelected(m); setConfirmRollback(false) }}
              >
                <Td className="font-mono text-muted-foreground">{String(m.version).padStart(3, "0")}</Td>
                <Td className="font-medium">{m.name}</Td>
                <Td><Badge variant={statusVariant[m.status]}>{m.status}</Badge></Td>
                <Td className="text-xs text-muted-foreground">
                  {m.applied_at ? new Date(m.applied_at).toLocaleString() : "\u2014"}
                </Td>
                <Td><Badge variant={riskVariant[m.risk_level]}>{m.risk_level}</Badge></Td>
                <Td className="text-xs text-muted-foreground">
                  {m.execution_time_ms !== null ? `${m.execution_time_ms}ms` : "\u2014"}
                </Td>
                <Td className="text-xs text-muted-foreground">{m.applied_by ?? "\u2014"}</Td>
                <Td className="font-mono text-[0.65rem] text-zinc-600">{m.checksum}</Td>
                <Td>
                  <Button
                    size="xs"
                    onClick={(e) => { e.stopPropagation(); setSelected(m); setConfirmRollback(false) }}
                  >
                    View
                  </Button>
                </Td>
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="text-center py-8 text-muted-foreground text-sm">
                  No migrations match your filters
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Card>

      <div className="text-xs text-muted-foreground mt-2">
        {filtered.length} of {migrations.length} migrations shown
      </div>

      {/* Expanded detail panel */}
      {selected ? (
        <Card className="p-4 mt-4">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h3 className="m-0">
                {selected.name}
                <span className="font-normal text-zinc-600 ml-2">v{selected.version}</span>
              </h3>
              <div className="flex gap-2 mt-1">
                <Badge variant={statusVariant[selected.status]}>{selected.status}</Badge>
                <Badge variant={riskVariant[selected.risk_level]}>{selected.risk_level}</Badge>
                {selected.execution_time_ms !== null ? (
                  <span className="text-xs text-muted-foreground">{selected.execution_time_ms}ms</span>
                ) : null}
              </div>
            </div>
            <Button onClick={() => setSelected(null)}>Close</Button>
          </div>

          {/* SQL diff view */}
          <SqlDiffView sqlUp={selected.sql_up} sqlDown={selected.sql_down} />

          {/* Rollback action */}
          {selected.status === "applied" && selected.sql_down ? (
            <div className="mt-4 border-t border-border pt-4">
              {!confirmRollback ? (
                <Button variant="destructive" onClick={() => setConfirmRollback(true)}>
                  Rollback this migration
                </Button>
              ) : (
                <div className="space-y-3">
                  <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-md">
                    <p className="text-red-400 text-sm font-medium mb-1">Confirm Rollback</p>
                    <p className="text-xs text-muted-foreground mb-2">
                      This will execute the rollback SQL and revert migration <strong>{selected.name}</strong> (v{selected.version}).
                      All subsequent migrations that depend on this one may also need to be rolled back.
                    </p>
                    <div className="mb-2">
                      <label className="block text-[0.7rem] text-muted-foreground uppercase mb-1">Rollback SQL to execute:</label>
                      <CodeBlock className="text-xs">{selected.sql_down}</CodeBlock>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="destructive">Confirm Rollback</Button>
                    <Button onClick={() => setConfirmRollback(false)}>Cancel</Button>
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </Card>
      ) : null}
    </>
  )
}
