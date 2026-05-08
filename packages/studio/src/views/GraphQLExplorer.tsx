import React, { useState } from "react"
import { useAdminConfig } from "../hooks/useAdminConfig.js"
import { useStudioClient } from "../StudioCore.js"
import { Button, CodeBlock } from "../components/ui.js"
import { cn } from "../lib/utils.js"

const PLACEHOLDER_QUERY = `query {
  # Replace with your table name
  posts {
    id
    title
    created_at
  }
}`

const AUTH_TABLES = [
  { name: "users",      label: "Users",      fields: ["id", "email", "created_at", "updated_at"] },
  { name: "sessions",   label: "Sessions",   fields: ["id", "user_id", "created_at", "not_after"] },
  { name: "identities", label: "Identities", fields: ["id", "user_id", "provider", "created_at"] },
]

export function GraphQLExplorer(): React.ReactElement {
  const config = useAdminConfig()
  const client = useStudioClient()

  const [query, setQuery] = useState(
    config.models[0]
      ? buildExampleQuery(config.models[0].tableName, config.models[0].fields.slice(0, 4).map((f) => f.name))
      : PLACEHOLDER_QUERY,
  )
  const [result, setResult] = useState<string>("")
  const [error, setError] = useState<string>("")
  const [loading, setLoading] = useState(false)

  async function runQuery() {
    setLoading(true)
    setError("")
    setResult("")
    try {
      const res = await client.graphql(query, {})
      setResult(JSON.stringify(res, null, 2))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const endpoint = `${client.url.replace(/\/+$/, "")}/graphql/v1`

  return (
    <div className="flex gap-4 h-full min-h-0" style={{ height: "calc(100vh - 120px)" }}>
      {/* Schema explorer */}
      <aside className="w-44 shrink-0 flex flex-col gap-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1 px-1">
          Types
        </div>
        {config.models.map((model) => (
          <button
            key={model.name}
            type="button"
            onClick={() =>
              setQuery(buildExampleQuery(model.tableName, model.fields.slice(0, 4).map((f) => f.name)))
            }
            className="text-left px-2 py-1.5 rounded text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors truncate"
          >
            {model.label}
          </button>
        ))}
        {config.models.length === 0 && (
          <p className="text-xs text-muted-foreground px-1">No models yet.</p>
        )}
        <div className="mt-2 pt-2 border-t border-border/60">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1 px-1">
            Auth
          </div>
          {AUTH_TABLES.map((t) => (
            <button
              key={t.name}
              type="button"
              onClick={() => setQuery(buildExampleQuery(t.name, t.fields))}
              className="text-left px-2 py-1.5 rounded text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors truncate w-full"
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="mt-auto pt-2 border-t border-border">
          <div className="text-[10px] text-muted-foreground/60 px-1 font-mono break-all">{endpoint}</div>
        </div>
      </aside>

      {/* Editor + result */}
      <div className="flex-1 flex flex-col gap-3 min-h-0 min-w-0">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground font-mono">POST /graphql/v1</span>
          <Button variant="primary" size="sm" onClick={runQuery} disabled={loading}>
            {loading ? "Running…" : "Run"}
          </Button>
        </div>

        <div className="flex gap-3 flex-1 min-h-0">
          {/* Query editor */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="text-xs text-muted-foreground mb-1">Query</div>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
              className="flex-1 font-mono text-[13px] bg-muted rounded-md p-3 resize-none focus:outline-none focus:ring-1 focus:ring-primary border border-border min-h-0"
            />
          </div>

          {/* Result */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="text-xs text-muted-foreground mb-1">Result</div>
            <pre
              className={cn(
                "flex-1 font-mono text-[13px] bg-muted rounded-md p-3 overflow-auto border border-border min-h-0",
                error && "border-destructive/50",
              )}
            >
              {error ? (
                <span className="text-destructive">{error}</span>
              ) : result ? (
                result
              ) : (
                <span className="text-muted-foreground/60">Run a query to see results.</span>
              )}
            </pre>
          </div>
        </div>
      </div>
    </div>
  )
}

function buildExampleQuery(tableName: string, fields: string[]): string {
  const fieldList = fields.length > 0 ? fields.join("\n    ") : "id"
  return `query {\n  ${tableName} {\n    ${fieldList}\n  }\n}`
}
