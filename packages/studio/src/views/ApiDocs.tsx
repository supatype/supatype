import React, { useState, useContext, useCallback, useMemo } from "react"
import { useStudioClient } from "../StudioCore.js"
import { AdminConfigContext } from "../hooks/useAdminConfig.js"
import { EmptyState } from "../components/EmptyState.js"
import { cn } from "../lib/utils.js"
import { Badge, Button, Card, CodeBlock, Input, Select, Th, Td } from "../components/ui.js"
import type { ModelConfig, FieldConfig, WidgetType } from "../config.js"

// ─── Types ────────────────────────────────────────────────────────────────────

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT"

interface ApiParam {
  name: string
  type: string
  required: boolean
  description: string
  location: "query" | "body" | "header" | "path"
  example?: string
}

interface ApiEndpoint {
  method: HttpMethod
  path: string
  description: string
  summary: string
  table: string
  category: "rest" | "auth" | "storage" | "realtime"
  params: ApiParam[]
  request_body_example?: string
  response_example?: string
  response_type?: string
}

interface TryItResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  duration: number
}

// ─── Endpoint Generation Helpers ──────────────────────────────────────────────

function widgetToApiType(widget: WidgetType): string {
  switch (widget) {
    case "uuid": return "uuid"
    case "number": return "number"
    case "boolean": case "publish": return "boolean"
    case "datetime": return "string (ISO 8601)"
    case "date": return "string (date)"
    case "json": case "blocks": return "object"
    case "relation": case "multirelation": return "uuid"
    default: return "string"
  }
}

function exampleForField(f: FieldConfig): string {
  switch (f.widget) {
    case "uuid": case "relation": case "multirelation": return "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    case "number": return "1"
    case "boolean": case "publish": return "true"
    case "datetime": return "2026-01-15T10:30:00Z"
    case "date": return "2026-01-15"
    case "json": case "blocks": return "{}"
    case "select": {
      const values = (f.options?.["values"] as string[] | undefined)
      return values?.[0] ?? "value"
    }
    default: return `example_${f.name}`
  }
}

function exampleValueForField(f: FieldConfig): unknown {
  switch (f.widget) {
    case "uuid": case "relation": case "multirelation": return "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    case "number": return 1
    case "boolean": case "publish": return true
    case "datetime": return "2026-01-15T10:30:00Z"
    case "date": return "2026-01-15"
    case "json": case "blocks": return {}
    default: return `example_${f.name}`
  }
}

function buildEndpointsFromModels(models?: ModelConfig[]): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = []

  for (const model of models ?? []) {
    const pkName = model.primaryKey || "id"
    const pkField = model.fields.find((f) => f.name === pkName)
    const pkType = pkField ? widgetToApiType(pkField.widget) : "uuid"
    const pkExample = pkField ? exampleForField(pkField) : "a1b2c3d4-e5f6-7890-abcd-ef1234567890"

    // Fields that can be set on insert (exclude auto-generated pk and timestamps)
    const AUTO = new Set(["created_at", "updated_at", "deleted_at"])
    const insertFields = model.fields.filter(
      (f) => f.name !== pkName && !AUTO.has(f.name),
    )
    const updateFields = model.fields.filter(
      (f) => f.name !== pkName && !AUTO.has(f.name),
    )

    const bodyExample = (fields: FieldConfig[]) => {
      const obj: Record<string, unknown> = {}
      for (const f of fields) obj[f.name] = exampleValueForField(f)
      return JSON.stringify(obj, null, 2)
    }
    const responseExample = (single = false) => {
      const obj: Record<string, unknown> = {}
      for (const f of model.fields) obj[f.name] = exampleValueForField(f)
      return single ? JSON.stringify(obj, null, 2) : JSON.stringify([obj], null, 2)
    }

    // GET — List all rows
    endpoints.push({
      method: "GET",
      path: `/rest/v1/${model.tableName}`,
      summary: `List all ${model.labelPlural}`,
      description: `List all ${model.labelPlural} with optional filtering, sorting, and pagination.`,
      table: model.tableName,
      category: "rest",
      params: [
        { name: "select", type: "string", required: false, description: "Comma-separated columns to return. Use * for all.", location: "query", example: "*" },
        { name: "order", type: "string", required: false, description: "Sort column (e.g. created_at.desc)", location: "query", example: `${pkName}.desc` },
        { name: "limit", type: "integer", required: false, description: "Max rows to return", location: "query", example: "25" },
        { name: "offset", type: "integer", required: false, description: "Rows to skip", location: "query", example: "0" },
      ],
      response_example: responseExample(),
      response_type: `${model.tableName}[]`,
    })

    // GET — Single row
    endpoints.push({
      method: "GET",
      path: `/rest/v1/${model.tableName}?${pkName}=eq.{${pkName}}`,
      summary: `Get ${model.label}`,
      description: `Get a single ${model.label} by ${pkName}.`,
      table: model.tableName,
      category: "rest",
      params: [
        { name: pkName, type: pkType, required: true, description: `Filter by ${pkName}`, location: "query", example: `eq.${pkExample}` },
      ],
      response_example: responseExample(true),
      response_type: model.tableName,
    })

    // POST — Insert
    endpoints.push({
      method: "POST",
      path: `/rest/v1/${model.tableName}`,
      summary: `Create ${model.label}`,
      description: `Insert a new ${model.label}.`,
      table: model.tableName,
      category: "rest",
      params: [
        ...insertFields.map((f) => ({
          name: f.name,
          type: widgetToApiType(f.widget),
          required: f.required,
          description: f.label || f.name,
          location: "body" as const,
          example: exampleForField(f),
        })),
        { name: "Prefer", type: "string", required: false, description: "Return=representation to get created record", location: "header", example: "return=representation" },
      ],
      request_body_example: bodyExample(insertFields),
    })

    // PATCH — Update
    endpoints.push({
      method: "PATCH",
      path: `/rest/v1/${model.tableName}?${pkName}=eq.{${pkName}}`,
      summary: `Update ${model.label}`,
      description: `Update a ${model.label} matching the filter.`,
      table: model.tableName,
      category: "rest",
      params: [
        { name: pkName, type: pkType, required: true, description: `Filter by ${pkName}`, location: "query", example: `eq.${pkExample}` },
        ...updateFields.map((f) => ({
          name: f.name,
          type: widgetToApiType(f.widget),
          required: false,
          description: f.label || f.name,
          location: "body" as const,
          example: exampleForField(f),
        })),
      ],
      request_body_example: bodyExample(updateFields),
    })

    // DELETE — Delete
    endpoints.push({
      method: "DELETE",
      path: `/rest/v1/${model.tableName}?${pkName}=eq.{${pkName}}`,
      summary: `Delete ${model.label}`,
      description: `Delete a ${model.label} matching the filter.`,
      table: model.tableName,
      category: "rest",
      params: [
        { name: pkName, type: pkType, required: true, description: `Filter by ${pkName}`, location: "query", example: `eq.${pkExample}` },
      ],
    })
  }

  // ── Auth endpoints ──
  endpoints.push(
    {
      method: "POST", path: "/auth/v1/signup", summary: "Sign up",
      description: "Register a new user account. Sends a confirmation email if email confirmation is enabled.",
      table: "auth", category: "auth",
      params: [
        { name: "email", type: "string", required: true, description: "Email address", location: "body" },
        { name: "password", type: "string", required: true, description: "Password (min 6 characters)", location: "body" },
        { name: "data", type: "object", required: false, description: "User metadata object", location: "body" },
      ],
      request_body_example: `{\n  "email": "user@example.com",\n  "password": "securepassword"\n}`,
      response_example: `{\n  "access_token": "eyJ...",\n  "token_type": "bearer",\n  "expires_in": 3600,\n  "user": { "id": "uuid", "email": "user@example.com" }\n}`,
    },
    {
      method: "POST", path: "/auth/v1/token?grant_type=password", summary: "Sign in",
      description: "Authenticate with email and password. Returns access and refresh tokens.",
      table: "auth", category: "auth",
      params: [
        { name: "email", type: "string", required: true, description: "Email address", location: "body" },
        { name: "password", type: "string", required: true, description: "Password", location: "body" },
      ],
      request_body_example: `{\n  "email": "user@example.com",\n  "password": "securepassword"\n}`,
      response_example: `{\n  "access_token": "eyJ...",\n  "token_type": "bearer",\n  "expires_in": 3600,\n  "refresh_token": "abc123"\n}`,
    },
    {
      method: "POST", path: "/auth/v1/logout", summary: "Sign out",
      description: "Invalidate the current session. Requires Authorization header.",
      table: "auth", category: "auth",
      params: [],
    },
    {
      method: "GET", path: "/auth/v1/user", summary: "Get current user",
      description: "Get the currently authenticated user. Requires Authorization header.",
      table: "auth", category: "auth",
      params: [],
      response_example: `{\n  "id": "uuid",\n  "email": "user@example.com",\n  "role": "authenticated"\n}`,
    },
  )

  // ── Storage endpoints ──
  endpoints.push(
    {
      method: "GET", path: "/storage/v1/bucket", summary: "List buckets",
      description: "List all storage buckets.",
      table: "storage", category: "storage",
      params: [],
      response_example: `[\n  { "id": "avatars", "name": "avatars", "public": true }\n]`,
    },
    {
      method: "POST", path: "/storage/v1/object/{bucket}/{path}", summary: "Upload file",
      description: "Upload a file to a storage bucket.",
      table: "storage", category: "storage",
      params: [
        { name: "bucket", type: "string", required: true, description: "Bucket name", location: "path" },
        { name: "path", type: "string", required: true, description: "File path within the bucket", location: "path" },
        { name: "Content-Type", type: "string", required: true, description: "MIME type of the file", location: "header" },
      ],
    },
    {
      method: "GET", path: "/storage/v1/object/{bucket}/{path}", summary: "Download file",
      description: "Download a file from a storage bucket. Public buckets allow unauthenticated access.",
      table: "storage", category: "storage",
      params: [
        { name: "bucket", type: "string", required: true, description: "Bucket name", location: "path" },
        { name: "path", type: "string", required: true, description: "File path within the bucket", location: "path" },
      ],
    },
    {
      method: "DELETE", path: "/storage/v1/object/{bucket}/{path}", summary: "Delete file",
      description: "Delete a file from a storage bucket.",
      table: "storage", category: "storage",
      params: [
        { name: "bucket", type: "string", required: true, description: "Bucket name", location: "path" },
        { name: "path", type: "string", required: true, description: "File path within the bucket", location: "path" },
      ],
    },
  )

  return endpoints
}

const methodColorClass: Record<string, string> = {
  GET: "text-green-400",
  POST: "text-blue-400",
  PATCH: "text-yellow-400",
  DELETE: "text-red-400",
  PUT: "text-orange-400",
}

const methodBgClass: Record<string, string> = {
  GET: "bg-green-500/15",
  POST: "bg-blue-500/15",
  PATCH: "bg-yellow-500/15",
  DELETE: "bg-red-500/15",
  PUT: "bg-orange-500/15",
}

const categories = [
  { value: "all", label: "All Endpoints" },
  { value: "rest", label: "REST API" },
  { value: "auth", label: "Authentication" },
  { value: "storage", label: "Storage" },
  { value: "realtime", label: "Realtime" },
]

// ─── "Try It" Panel ───────────────────────────────────────────────────────────

function TryItPanel({
  endpoint,
  baseUrl,
  onClose,
}: {
  endpoint: ApiEndpoint
  baseUrl: string
  onClose: () => void
}): React.ReactElement {
  const [paramValues, setParamValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const p of endpoint.params) {
      init[p.name] = p.example ?? ""
    }
    return init
  })
  const [authToken, setAuthToken] = useState("")
  const [requestBody, setRequestBody] = useState(endpoint.request_body_example ?? "")
  const [response, setResponse] = useState<TryItResponse | null>(null)
  const [loading, setLoading] = useState(false)

  const handleExecute = async () => {
    setLoading(true)
    setResponse(null)
    const start = performance.now()

    try {
      const splitPath = endpoint.path.split("?")
      const basePath = splitPath[0] ?? endpoint.path
      const templateQuery = splitPath[1]

      let resolvedPath = basePath
      for (const p of endpoint.params.filter((p) => p.location === "path")) {
        resolvedPath = resolvedPath.replaceAll(`{${p.name}}`, encodeURIComponent(paramValues[p.name] ?? ""))
      }

      const queryParts: string[] = []
      if (templateQuery) {
        for (const part of templateQuery.split("&")) {
          if (!part.includes("{")) queryParts.push(part)
        }
      }
      for (const p of endpoint.params.filter((p) => p.location === "query")) {
        const v = paramValues[p.name]
        if (v) {
          queryParts.push(`${encodeURIComponent(p.name)}=${encodeURIComponent(v)}`)
        }
      }

      const qs = queryParts.length > 0 ? "?" + queryParts.join("&") : ""
      const url = `${baseUrl}${resolvedPath}${qs}`

      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (authToken) headers["Authorization"] = `Bearer ${authToken}`
      for (const p of endpoint.params.filter((p) => p.location === "header")) {
        const v = paramValues[p.name]
        if (v) headers[p.name] = v
      }

      const fetchOpts: RequestInit = { method: endpoint.method, headers, credentials: "include" }
      if (requestBody && endpoint.method !== "GET" && endpoint.method !== "DELETE") {
        fetchOpts.body = requestBody
      }

      const res = await fetch(url, fetchOpts)
      const duration = Math.round(performance.now() - start)

      const responseHeaders: Record<string, string> = {}
      res.headers.forEach((v, k) => { responseHeaders[k] = v })

      let body: string
      const ct = res.headers.get("content-type") ?? ""
      if (ct.includes("application/json")) {
        body = JSON.stringify(await res.json(), null, 2)
      } else {
        body = await res.text()
      }

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

  return (
    <Card className="p-4 mt-4">
      <div className="flex justify-between items-center mb-3">
        <h4 className="m-0">Try It</h4>
        <Button size="xs" onClick={onClose}>Close</Button>
      </div>

      {/* Auth token */}
      <div className="mb-3">
        <label className="block text-[0.7rem] text-muted-foreground uppercase mb-1">Authorization Bearer Token</label>
        <Input
          value={authToken}
          onChange={(e) => setAuthToken(e.target.value)}
          placeholder="eyJ..."
          className="font-mono text-xs"
        />
      </div>

      {/* Query/path params */}
      {endpoint.params.filter((p) => p.location === "query" || p.location === "path").length > 0 ? (
        <div className="mb-3">
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-1">Parameters</label>
          <div className="grid grid-cols-2 gap-2">
            {endpoint.params.filter((p) => p.location === "query" || p.location === "path").map((p) => (
              <div key={p.name}>
                <label className="text-[0.65rem] text-zinc-600">{p.name} {p.required ? <span className="text-red-400">*</span> : null}</label>
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
      ) : null}

      {/* Request body */}
      {endpoint.method !== "GET" && endpoint.method !== "DELETE" ? (
        <div className="mb-3">
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-1">Request Body (JSON)</label>
          <textarea
            className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-foreground text-xs font-mono focus:outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 min-h-[80px] resize-y"
            value={requestBody}
            onChange={(e) => setRequestBody(e.target.value)}
          />
        </div>
      ) : null}

      <Button variant="primary" size="sm" onClick={() => void handleExecute()} disabled={loading}>
        {loading ? "Sending..." : `Send ${endpoint.method} Request`}
      </Button>

      {/* Response */}
      {response ? (
        <div className="mt-4">
          <div className="flex items-center gap-2 mb-2">
            <span className={cn("font-mono font-bold text-sm", response.status < 400 ? "text-green-400" : "text-red-400")}>
              {response.status} {response.statusText}
            </span>
            <span className="text-xs text-muted-foreground">{response.duration}ms</span>
          </div>
          <div className="mb-2">
            <label className="block text-[0.65rem] text-muted-foreground uppercase mb-0.5">Response Headers</label>
            <div className="text-xs font-mono text-muted-foreground">
              {Object.entries(response.headers).map(([k, v]) => (
                <div key={k}>{k}: {v}</div>
              ))}
            </div>
          </div>
          <label className="block text-[0.65rem] text-muted-foreground uppercase mb-0.5">Response Body</label>
          <CodeBlock className="text-xs">{response.body}</CodeBlock>
        </div>
      ) : null}
    </Card>
  )
}

// ─── Auth Section ─────────────────────────────────────────────────────────────

function AuthSection(): React.ReactElement {
  return (
    <Card className="p-4 mb-4">
      <h3 className="m-0 mb-3">Authentication</h3>
      <p className="text-sm text-muted-foreground mb-3">
        All API requests require authentication via a Bearer token in the Authorization header.
      </p>

      <div className="space-y-3">
        <div>
          <h4 className="text-sm mb-1">Anonymous Access (anon key)</h4>
          <p className="text-xs text-muted-foreground mb-1">
            Use the <code>anon</code> key for public/client-side requests. Data is protected by Row Level Security policies.
          </p>
          <CodeBlock className="text-xs">
{`curl -X GET \\
  'https://your-project.supatype.io/rest/v1/posts' \\
  -H 'apikey: YOUR_ANON_KEY' \\
  -H 'Authorization: Bearer YOUR_ANON_KEY'`}
          </CodeBlock>
        </div>

        <div>
          <h4 className="text-sm mb-1">Authenticated Requests (user JWT)</h4>
          <p className="text-xs text-muted-foreground mb-1">
            After sign-in, use the returned access_token. RLS policies evaluate against the user's JWT claims.
          </p>
          <CodeBlock className="text-xs">
{`curl -X GET \\
  'https://your-project.supatype.io/rest/v1/posts' \\
  -H 'apikey: YOUR_ANON_KEY' \\
  -H 'Authorization: Bearer USER_ACCESS_TOKEN'`}
          </CodeBlock>
        </div>

        <div>
          <h4 className="text-sm mb-1">Service Role (admin, server-only)</h4>
          <p className="text-xs text-muted-foreground mb-1">
            The <code>service_role</code> key bypasses RLS. Never expose in client code.
          </p>
          <CodeBlock className="text-xs">
{`curl -X GET \\
  'https://your-project.supatype.io/rest/v1/posts' \\
  -H 'apikey: YOUR_SERVICE_ROLE_KEY' \\
  -H 'Authorization: Bearer YOUR_SERVICE_ROLE_KEY'`}
          </CodeBlock>
        </div>
      </div>
    </Card>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function ApiDocs(): React.ReactElement {
  const client = useStudioClient()
  const config = useContext(AdminConfigContext)

  // Endpoints are built from the admin config (user models + hardcoded auth/storage).
  // No DB introspection needed — that prevents GoTrue internal tables from leaking in.
  const endpoints = useMemo(
    () => buildEndpointsFromModels(config?.models),
    [config],
  )

  const [expanded, setExpanded] = useState<string | null>(null)
  const [tryItEndpoint, setTryItEndpoint] = useState<string | null>(null)
  const [filterCategory, setFilterCategory] = useState("all")
  const [filterTable, setFilterTable] = useState("all")
  const [search, setSearch] = useState("")

  const tableNames = useMemo(() => [...new Set(endpoints.map((e) => e.table))], [endpoints])

  const filtered = useMemo(() => {
    return endpoints.filter((e) => {
      if (filterCategory !== "all" && e.category !== filterCategory) return false
      if (filterTable !== "all" && e.table !== filterTable) return false
      if (search) {
        const s = search.toLowerCase()
        if (!e.path.toLowerCase().includes(s) && !e.summary.toLowerCase().includes(s) && !e.description.toLowerCase().includes(s)) return false
      }
      return true
    })
  }, [endpoints, filterCategory, filterTable, search])

  const toggleExpand = (key: string) => {
    setExpanded(expanded === key ? null : key)
    if (expanded === key) setTryItEndpoint(null)
  }

  return (
    <>
      {/* Auth section */}
      <AuthSection />

      {!config ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Loading API endpoints…</div>
      ) : !config.models?.length ? (
        <EmptyState
          title="No model endpoints yet"
          description="Push a schema first — define models in your supatype config and run `supatype push`."
        />
      ) : (
        <>
          {/* Filters */}
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <Input
              className="w-[250px]"
              placeholder="Search endpoints..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select className="w-[150px]" value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
              {categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </Select>
            <Select className="w-[130px]" value={filterTable} onChange={(e) => setFilterTable(e.target.value)}>
              <option value="all">All tables</option>
              {tableNames.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </div>

          {/* Endpoint list */}
          <div className="flex flex-col gap-3">
            {filtered.map((ep) => {
              const key = `${ep.method}-${ep.path}`
              const isExpanded = expanded === key
              const isTryingIt = tryItEndpoint === key

              return (
                <Card key={key}>
                  <div
                    onClick={() => toggleExpand(key)}
                    className="flex items-center gap-3 px-4 py-3 cursor-pointer"
                  >
                    <span className={cn(
                      "font-mono font-bold text-xs min-w-[4rem] px-1.5 py-0.5 rounded text-center",
                      methodColorClass[ep.method] ?? "text-foreground",
                      methodBgClass[ep.method] ?? ""
                    )}>
                      {ep.method}
                    </span>
                    <code className="text-[0.8rem] text-foreground">{ep.path}</code>
                    <span className="ml-auto text-zinc-600 text-xs">{ep.summary}</span>
                    <Badge variant="blue" className="text-[0.55rem]">{ep.category}</Badge>
                  </div>

                  {isExpanded ? (
                    <div className="border-t border-border p-4">
                      <p className="text-muted-foreground text-[0.8rem] mb-4">{ep.description}</p>

                      {ep.response_type ? (
                        <div className="mb-3">
                          <span className="text-xs text-muted-foreground">Response type: </span>
                          <code className="text-primary text-xs">{ep.response_type}</code>
                        </div>
                      ) : null}

                      {/* Parameters */}
                      {ep.params.length > 0 ? (
                        <>
                          <h4 className="text-xs text-muted-foreground mb-2 uppercase">Parameters</h4>
                          <Card className="overflow-auto mb-4">
                            <table className="w-full">
                              <thead>
                                <tr className="border-b border-border">
                                  <Th>Name</Th>
                                  <Th>Location</Th>
                                  <Th>Type</Th>
                                  <Th>Required</Th>
                                  <Th>Description</Th>
                                </tr>
                              </thead>
                              <tbody>
                                {ep.params.map((p) => (
                                  <tr key={p.name} className="border-b border-border hover:bg-accent/50">
                                    <Td><code className="text-primary">{p.name}</code></Td>
                                    <Td><Badge variant="blue" className="text-[0.6rem]">{p.location}</Badge></Td>
                                    <Td className="text-muted-foreground">{p.type}</Td>
                                    <Td>{p.required ? <span className="text-red-400">required</span> : "optional"}</Td>
                                    <Td className="text-muted-foreground text-xs">{p.description}</Td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </Card>
                        </>
                      ) : null}

                      {/* Request body example */}
                      {ep.request_body_example ? (
                        <div className="mb-4">
                          <h4 className="text-xs text-muted-foreground mb-2 uppercase">Request Body Example</h4>
                          <CodeBlock className="text-xs">{ep.request_body_example}</CodeBlock>
                        </div>
                      ) : null}

                      {/* Response example */}
                      {ep.response_example ? (
                        <div className="mb-4">
                          <h4 className="text-xs text-muted-foreground mb-2 uppercase">Example Response</h4>
                          <CodeBlock className="text-xs">{ep.response_example}</CodeBlock>
                        </div>
                      ) : null}

                      {/* Try it button */}
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => setTryItEndpoint(isTryingIt ? null : key)}
                      >
                        {isTryingIt ? "Close Try It" : "Try It"}
                      </Button>

                      {isTryingIt ? (
                        <TryItPanel
                          endpoint={ep}
                          baseUrl={client.url}
                          onClose={() => setTryItEndpoint(null)}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </Card>
              )
            })}

            {filtered.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                No endpoints match your filters
              </div>
            ) : null}
          </div>
        </>
      )}
    </>
  )
}
