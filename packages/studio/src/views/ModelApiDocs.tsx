import React, { useState } from "react"
import type { ModelConfig, FieldConfig } from "../config.js"
import { Button, Card, CodeBlock, Input } from "../components/ui.js"
import { useStudioClient } from "../StudioCore.js"
import { cn } from "../lib/utils.js"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function exampleValue(f: FieldConfig): unknown {
  switch (f.widget) {
    case "uuid": case "relation": case "multirelation":
      return "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    case "number": return 1
    case "boolean": case "publish": return true
    case "datetime": return "2026-01-15T10:30:00Z"
    case "date": return "2026-01-15"
    case "json": case "blocks": return {}
    default: return `example_${f.name}`
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

type Method = "GET" | "POST" | "PATCH" | "DELETE"

interface Param {
  name: string
  type: string
  required: boolean
  description: string
  location: "query" | "body" | "header" | "path"
  example?: string
}

interface Endpoint {
  method: Method
  path: string
  summary: string
  description: string
  params: Param[]
  requestBody?: string
  response?: string
  sdkSnippet: string
}

interface TryItResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  duration: number
}

// ─── Endpoint builder ─────────────────────────────────────────────────────────

function buildEndpoints(model: ModelConfig): Endpoint[] {
  const pk = model.primaryKey || "id"
  const pkField = model.fields.find((f) => f.name === pk)
  const pkEx = pkField ? String(exampleValue(pkField)) : "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  const AUTO = new Set(["created_at", "updated_at", "deleted_at"])
  const writeable = model.fields.filter((f) => f.name !== pk && !AUTO.has(f.name))
  const t = model.tableName

  const rowObj = () => {
    const obj: Record<string, unknown> = {}
    for (const f of model.fields) obj[f.name] = exampleValue(f)
    return obj
  }
  const bodyObj = (fields: FieldConfig[]) => {
    const obj: Record<string, unknown> = {}
    for (const f of fields) obj[f.name] = exampleValue(f)
    return JSON.stringify(obj, null, 2)
  }

  return [
    {
      method: "GET",
      path: `/rest/v1/${t}`,
      summary: `List ${model.labelPlural}`,
      description: `Returns all ${model.labelPlural}. Filter with \`${pk}=eq.{value}\`, sort with \`order=${pk}.desc\`, and paginate with \`limit\` and \`offset\`.`,
      params: [
        { name: "select", type: "string", required: false, description: "Columns to return", location: "query", example: "*" },
        { name: "order",  type: "string", required: false, description: `Sort column (e.g. ${pk}.desc)`, location: "query", example: `${pk}.desc` },
        { name: "limit",  type: "integer", required: false, description: "Max rows", location: "query", example: "25" },
        { name: "offset", type: "integer", required: false, description: "Rows to skip", location: "query", example: "0" },
      ],
      response: JSON.stringify([rowObj()], null, 2),
      sdkSnippet: `const { data, error } = await client\n  .from('${t}')\n  .select('*')`,
    },
    {
      method: "GET",
      path: `/rest/v1/${t}`,
      summary: `Get ${model.label}`,
      description: `Returns a single ${model.label} filtered by \`${pk}\`.`,
      params: [
        { name: pk,       type: "string", required: true,  description: `Filter by ${pk}`, location: "query", example: `eq.${pkEx}` },
        { name: "select", type: "string", required: false, description: "Columns to return", location: "query", example: "*" },
      ],
      response: JSON.stringify(rowObj(), null, 2),
      sdkSnippet: `const { data, error } = await client\n  .from('${t}')\n  .select('*')\n  .eq('${pk}', '${pkEx}')`,
    },
    {
      method: "POST",
      path: `/rest/v1/${t}`,
      summary: `Create ${model.label}`,
      description: `Inserts a new ${model.label}. Add \`Prefer: return=representation\` header to get the created row back.`,
      params: [
        { name: "Prefer", type: "string", required: false, description: "Return=representation to get created row", location: "header", example: "return=representation" },
        ...writeable.map((f) => ({ name: f.name, type: typeof exampleValue(f), required: !!f.required, description: f.label || f.name, location: "body" as const, example: String(exampleValue(f)) })),
      ],
      requestBody: bodyObj(writeable),
      response: JSON.stringify(rowObj(), null, 2),
      sdkSnippet: `const { data, error } = await client\n  .from('${t}')\n  .insert(${bodyObj(writeable)})`,
    },
    {
      method: "PATCH",
      path: `/rest/v1/${t}`,
      summary: `Update ${model.label}`,
      description: `Updates a ${model.label} matching \`${pk}\`. Only include fields you want to change.`,
      params: [
        { name: pk, type: "string", required: true, description: `Filter by ${pk}`, location: "query", example: `eq.${pkEx}` },
        ...writeable.slice(0, 3).map((f) => ({ name: f.name, type: typeof exampleValue(f), required: false, description: f.label || f.name, location: "body" as const, example: String(exampleValue(f)) })),
      ],
      requestBody: bodyObj(writeable.slice(0, 3)),
      sdkSnippet: `const { data, error } = await client\n  .from('${t}')\n  .update({ /* fields to change */ })\n  .eq('${pk}', '${pkEx}')`,
    },
    {
      method: "DELETE",
      path: `/rest/v1/${t}`,
      summary: `Delete ${model.label}`,
      description: `Deletes a ${model.label} matching \`${pk}\`.`,
      params: [
        { name: pk, type: "string", required: true, description: `Filter by ${pk}`, location: "query", example: `eq.${pkEx}` },
      ],
      sdkSnippet: `const { data, error } = await client\n  .from('${t}')\n  .delete()\n  .eq('${pk}', '${pkEx}')`,
    },
  ]
}

// ─── Try It panel ─────────────────────────────────────────────────────────────

const METHOD_COLOR: Record<Method, string> = {
  GET: "text-green-400",
  POST: "text-blue-400",
  PATCH: "text-yellow-400",
  DELETE: "text-red-400",
}

const METHOD_BG: Record<Method, string> = {
  GET: "bg-green-500/15",
  POST: "bg-blue-500/15",
  PATCH: "bg-yellow-500/15",
  DELETE: "bg-red-500/15",
}

function TryItPanel({ ep, baseUrl, onClose }: { ep: Endpoint; baseUrl: string; onClose: () => void }) {
  const [paramValues, setParamValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const p of ep.params) init[p.name] = p.example ?? ""
    return init
  })
  const [authToken, setAuthToken] = useState("")
  const [requestBody, setRequestBody] = useState(ep.requestBody ?? "")
  const [response, setResponse] = useState<TryItResponse | null>(null)
  const [loading, setLoading] = useState(false)

  const handleExecute = async () => {
    setLoading(true)
    setResponse(null)
    const start = performance.now()
    try {
      const queryParts: string[] = []
      for (const p of ep.params.filter((p) => p.location === "query")) {
        const v = paramValues[p.name]
        if (v) queryParts.push(`${encodeURIComponent(p.name)}=${encodeURIComponent(v)}`)
      }
      const qs = queryParts.length > 0 ? "?" + queryParts.join("&") : ""
      const url = `${baseUrl}${ep.path}${qs}`

      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (authToken) headers["Authorization"] = `Bearer ${authToken}`
      for (const p of ep.params.filter((p) => p.location === "header")) {
        const v = paramValues[p.name]
        if (v) headers[p.name] = v
      }

      const fetchOpts: RequestInit = { method: ep.method, headers, credentials: "include" }
      if (requestBody && ep.method !== "GET" && ep.method !== "DELETE") {
        fetchOpts.body = requestBody
      }

      const res = await fetch(url, fetchOpts)
      const duration = Math.round(performance.now() - start)
      const responseHeaders: Record<string, string> = {}
      res.headers.forEach((v, k) => { responseHeaders[k] = v })

      const ct = res.headers.get("content-type") ?? ""
      const body = ct.includes("application/json")
        ? JSON.stringify(await res.json(), null, 2)
        : await res.text()

      setResponse({ status: res.status, statusText: res.statusText, headers: responseHeaders, body, duration })
    } catch (err) {
      setResponse({
        status: 0,
        statusText: "Network Error",
        headers: {},
        body: err instanceof Error ? err.message : "Request failed",
        duration: Math.round(performance.now() - start),
      })
    } finally {
      setLoading(false)
    }
  }

  const queryParams = ep.params.filter((p) => p.location === "query" || p.location === "path")
  const headerParams = ep.params.filter((p) => p.location === "header")

  return (
    <Card className="p-4 mt-4">
      <div className="flex justify-between items-center mb-3">
        <h4 className="m-0 text-sm font-semibold">Try It</h4>
        <Button size="xs" onClick={onClose}>Close</Button>
      </div>

      <div className="mb-3">
        <label className="block text-[0.7rem] text-muted-foreground uppercase mb-1">Authorization Bearer Token</label>
        <Input value={authToken} onChange={(e) => setAuthToken(e.target.value)} placeholder="eyJ..." className="font-mono text-xs" />
      </div>

      {queryParams.length > 0 && (
        <div className="mb-3">
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-1">Query Parameters</label>
          <div className="grid grid-cols-2 gap-2">
            {queryParams.map((p) => (
              <div key={p.name}>
                <label className="text-[0.65rem] text-muted-foreground">
                  {p.name}{p.required && <span className="text-red-400 ml-0.5">*</span>}
                </label>
                <Input
                  className="text-xs"
                  value={paramValues[p.name] ?? ""}
                  onChange={(e) => setParamValues((prev) => ({ ...prev, [p.name]: e.target.value }))}
                  placeholder={p.example ?? p.type}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {headerParams.length > 0 && (
        <div className="mb-3">
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-1">Headers</label>
          <div className="grid grid-cols-2 gap-2">
            {headerParams.map((p) => (
              <div key={p.name}>
                <label className="text-[0.65rem] text-muted-foreground">{p.name}</label>
                <Input
                  className="text-xs"
                  value={paramValues[p.name] ?? ""}
                  onChange={(e) => setParamValues((prev) => ({ ...prev, [p.name]: e.target.value }))}
                  placeholder={p.example ?? p.type}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {ep.method !== "GET" && ep.method !== "DELETE" && (
        <div className="mb-3">
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-1">Request Body (JSON)</label>
          <textarea
            className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-foreground text-xs font-mono focus:outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 min-h-[80px] resize-y"
            value={requestBody}
            onChange={(e) => setRequestBody(e.target.value)}
          />
        </div>
      )}

      <Button variant="primary" size="sm" onClick={() => void handleExecute()} disabled={loading}>
        {loading ? "Sending…" : `Send ${ep.method} Request`}
      </Button>

      {response && (
        <div className="mt-4">
          <div className="flex items-center gap-2 mb-2">
            <span className={cn("font-mono font-bold text-sm", response.status < 400 ? "text-green-400" : "text-red-400")}>
              {response.status} {response.statusText}
            </span>
            <span className="text-xs text-muted-foreground">{response.duration}ms</span>
          </div>
          <div className="mb-2 text-xs font-mono text-muted-foreground">
            {Object.entries(response.headers).map(([k, v]) => (
              <div key={k}>{k}: {v}</div>
            ))}
          </div>
          <CodeBlock className="text-xs">{response.body}</CodeBlock>
        </div>
      )}
    </Card>
  )
}

// ─── Endpoint card ────────────────────────────────────────────────────────────

function EndpointCard({ ep, open, onToggle, baseUrl }: { ep: Endpoint; open: boolean; onToggle: () => void; baseUrl: string }) {
  const [tryItOpen, setTryItOpen] = useState(false)

  // Reset try-it panel when the card collapses
  React.useEffect(() => {
    if (!open) setTryItOpen(false)
  }, [open])

  return (
    <div className="border border-border/70 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent/40 transition-colors text-left"
      >
        <span
          className={cn(
            "font-mono text-[11px] font-bold w-14 shrink-0 text-center px-1.5 py-0.5 rounded",
            METHOD_COLOR[ep.method],
            METHOD_BG[ep.method],
          )}
        >
          {ep.method}
        </span>
        <span className="font-mono text-[12px] text-muted-foreground flex-1 min-w-0 truncate">{ep.path}</span>
        <span className="text-sm font-medium text-foreground shrink-0">{ep.summary}</span>
        <span className="text-muted-foreground/40 ml-2 shrink-0 text-xs">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="border-t border-border/60 px-4 pb-4 pt-3 space-y-4 bg-muted/20">
          <p className="text-sm text-muted-foreground">{ep.description}</p>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">
              TypeScript SDK
            </p>
            <CodeBlock>{ep.sdkSnippet}</CodeBlock>
          </div>
          {ep.requestBody && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">
                Request body
              </p>
              <CodeBlock>{ep.requestBody}</CodeBlock>
            </div>
          )}
          {ep.response && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">
                Example response
              </p>
              <CodeBlock>{ep.response}</CodeBlock>
            </div>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={() => setTryItOpen((v) => !v)}
          >
            {tryItOpen ? "Close Try It" : "Try It"}
          </Button>
          {tryItOpen && (
            <TryItPanel ep={ep} baseUrl={baseUrl} onClose={() => setTryItOpen(false)} />
          )}
        </div>
      )}
    </div>
  )
}

// ─── ModelApiDocs ─────────────────────────────────────────────────────────────

interface Props {
  model: ModelConfig
}

export function ModelApiDocs({ model }: Props): React.ReactElement {
  const client = useStudioClient()
  const endpoints = buildEndpoints(model)
  const [open, setOpen] = useState<number | null>(0)

  return (
    <div className="max-w-3xl">
      <div className="mb-5">
        <h2 className="text-base font-semibold">{model.labelPlural} — REST API</h2>
        <p className="text-sm text-muted-foreground mt-1">
          PostgREST endpoints for{" "}
          <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">{model.tableName}</code>.
          {" "}Base URL:{" "}
          <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">/rest/v1</code>.
        </p>
      </div>
      <div className="space-y-2">
        {endpoints.map((ep, i) => (
          <EndpointCard
            key={ep.method + ep.summary}
            ep={ep}
            open={open === i}
            onToggle={() => setOpen(open === i ? null : i)}
            baseUrl={client.url}
          />
        ))}
      </div>
    </div>
  )
}
