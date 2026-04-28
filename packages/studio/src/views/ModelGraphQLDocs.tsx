import React, { useState } from "react"
import type { ModelConfig } from "../config.js"
import { Button } from "../components/ui.js"
import { useStudioClient } from "../StudioCore.js"
import { cn } from "../lib/utils.js"

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function buildOperations(model: ModelConfig) {
  const t = model.tableName
  const pk = model.primaryKey || "id"
  const pkEx = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  const AUTO = new Set(["created_at", "updated_at", "deleted_at"])

  const fieldLines = model.fields
    .slice(0, 6)
    .map((f) => `        ${f.name}`)
    .join("\n")

  const insertFields = model.fields.filter((f) => f.name !== pk && !AUTO.has(f.name))
  const insertPairs = insertFields
    .map((f) => `        ${f.name}: "example_${f.name}"`)
    .join("\n")

  return [
    {
      label: "List",
      description: `Fetch all ${model.labelPlural}.`,
      query: `query List${cap(t)} {
  ${t}Collection {
    edges {
      node {
${fieldLines}
      }
    }
  }
}`,
    },
    {
      label: "Get by ID",
      description: `Fetch a single ${model.label} by ${pk}.`,
      query: `query Get${cap(t)}ById {
  ${t}Collection(
    filter: { ${pk}: { eq: "${pkEx}" } }
  ) {
    edges {
      node {
${fieldLines}
      }
    }
  }
}`,
    },
    {
      label: "Insert",
      description: `Create a new ${model.label}.`,
      query: `mutation Insert${cap(t)} {
  insertInto${cap(t)}Collection(
    objects: [{
${insertPairs}
    }]
  ) {
    records {
      ${pk}
    }
  }
}`,
    },
    {
      label: "Update",
      description: `Update a ${model.label} by ${pk}.`,
      query: `mutation Update${cap(t)} {
  update${cap(t)}Collection(
    filter: { ${pk}: { eq: "${pkEx}" } }
    set: {
      # fields to update
    }
  ) {
    records {
${fieldLines}
    }
  }
}`,
    },
    {
      label: "Delete",
      description: `Delete a ${model.label} by ${pk}.`,
      query: `mutation Delete${cap(t)} {
  deleteFrom${cap(t)}Collection(
    filter: { ${pk}: { eq: "${pkEx}" } }
  ) {
    records {
      ${pk}
    }
  }
}`,
    },
  ]
}

interface Props {
  model: ModelConfig
}

export function ModelGraphQLDocs({ model }: Props): React.ReactElement {
  const client = useStudioClient()
  const operations = buildOperations(model)
  const [selectedOp, setSelectedOp] = useState(0)
  const [query, setQuery] = useState(operations[0]?.query ?? "")
  const [result, setResult] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  function selectOp(i: number) {
    setSelectedOp(i)
    setQuery(operations[i]?.query ?? "")
    setResult("")
    setError("")
  }

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

  return (
    <div className="flex gap-4" style={{ height: "calc(100vh - 160px)" }}>
      {/* Operation selector */}
      <aside className="w-40 shrink-0 flex flex-col gap-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1 px-1">
          Operations
        </div>
        {operations.map((op, i) => (
          <button
            key={op.label}
            type="button"
            onClick={() => selectOp(i)}
            className={cn(
              "text-left px-2 py-1.5 rounded text-sm transition-colors",
              selectedOp === i
                ? "bg-accent text-foreground font-medium"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {op.label}
          </button>
        ))}
        <div className="mt-auto pt-2 border-t border-border/60 text-[10px] text-muted-foreground/60 px-1 font-mono break-all">
          POST /graphql/v1
        </div>
      </aside>

      {/* Editor + result */}
      <div className="flex-1 flex flex-col gap-3 min-h-0 min-w-0">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            {operations[selectedOp]?.description}
          </span>
          <Button variant="primary" size="sm" onClick={runQuery} disabled={loading}>
            {loading ? "Running…" : "Run"}
          </Button>
        </div>
        <div className="flex gap-3 flex-1 min-h-0">
          <div className="flex-1 flex flex-col min-h-0">
            <div className="text-xs text-muted-foreground mb-1">Query</div>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
              className="flex-1 font-mono text-[13px] bg-muted rounded-md p-3 resize-none focus:outline-none focus:ring-1 focus:ring-primary border border-border min-h-0"
            />
          </div>
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
                <span className="text-muted-foreground/60">Run the query to see results.</span>
              )}
            </pre>
          </div>
        </div>
      </div>
    </div>
  )
}
