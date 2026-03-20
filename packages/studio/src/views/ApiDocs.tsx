import React, { useState, useCallback, useMemo } from "react"
import { useStudioClient } from "../StudioApp.js"
import { cn } from "../lib/utils.js"
import { Badge, Button, Card, CodeBlock, Input, Select, Th, Td } from "../components/ui.js"

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

// ─── Mock Data ────────────────────────────────────────────────────────────────

const mockEndpoints: ApiEndpoint[] = [
  {
    method: "GET",
    path: "/rest/v1/users",
    summary: "List users",
    description: "List all users with optional filtering, sorting, and pagination. Supports PostgREST query syntax.",
    table: "users",
    category: "rest",
    params: [
      { name: "select", type: "string", required: false, description: "Comma-separated list of columns to return. Supports nested selects.", location: "query", example: "*,posts(title)" },
      { name: "order", type: "string", required: false, description: "Column to sort by (e.g. name.asc, created_at.desc)", location: "query", example: "created_at.desc" },
      { name: "limit", type: "integer", required: false, description: "Maximum number of rows to return", location: "query", example: "25" },
      { name: "offset", type: "integer", required: false, description: "Number of rows to skip", location: "query", example: "0" },
      { name: "id", type: "uuid", required: false, description: "Filter by ID (eq, neq, in, gt, lt, gte, lte)", location: "query", example: "eq.a1b2c3d4" },
      { name: "email", type: "string", required: false, description: "Filter by email", location: "query", example: "eq.alice@example.com" },
    ],
    response_example: `[\n  {\n    "id": "a1b2c3d4",\n    "email": "alice@example.com",\n    "name": "Alice",\n    "created_at": "2026-01-15T10:30:00Z"\n  }\n]`,
    response_type: "User[]",
  },
  {
    method: "POST",
    path: "/rest/v1/users",
    summary: "Create user",
    description: "Create a new user record. Returns the created record by default.",
    table: "users",
    category: "rest",
    params: [
      { name: "email", type: "string", required: true, description: "User email address", location: "body" },
      { name: "name", type: "string", required: true, description: "User display name", location: "body" },
      { name: "Prefer", type: "string", required: false, description: "Set to 'return=representation' to return created record", location: "header", example: "return=representation" },
    ],
    request_body_example: `{\n  "email": "new@example.com",\n  "name": "New User"\n}`,
    response_example: `{\n  "id": "new-uuid",\n  "email": "new@example.com",\n  "name": "New User",\n  "created_at": "2026-03-17T10:00:00Z"\n}`,
    response_type: "User",
  },
  {
    method: "PATCH",
    path: "/rest/v1/users",
    summary: "Update users",
    description: "Update users matching the filter. Use query parameters to filter which rows to update.",
    table: "users",
    category: "rest",
    params: [
      { name: "id", type: "uuid", required: false, description: "Filter by user ID", location: "query", example: "eq.a1b2c3d4" },
      { name: "name", type: "string", required: false, description: "New name value", location: "body" },
    ],
    request_body_example: `{\n  "name": "Updated Name"\n}`,
  },
  {
    method: "DELETE",
    path: "/rest/v1/users",
    summary: "Delete users",
    description: "Delete users matching the filter. Always filter to avoid deleting all rows.",
    table: "users",
    category: "rest",
    params: [
      { name: "id", type: "uuid", required: true, description: "Filter by user ID", location: "query", example: "eq.a1b2c3d4" },
    ],
  },
  {
    method: "GET",
    path: "/rest/v1/posts",
    summary: "List posts",
    description: "List all posts with optional filtering. Supports embedding related records.",
    table: "posts",
    category: "rest",
    params: [
      { name: "select", type: "string", required: false, description: "Columns and nested relations", location: "query", example: "*,author:users(name)" },
      { name: "status", type: "string", required: false, description: "Filter by status", location: "query", example: "eq.published" },
    ],
    response_example: `[\n  {\n    "id": "post-1",\n    "title": "Hello World",\n    "slug": "hello-world",\n    "status": "published",\n    "author": { "name": "Alice" }\n  }\n]`,
    response_type: "Post[]",
  },
  {
    method: "POST",
    path: "/rest/v1/posts",
    summary: "Create post",
    description: "Create a new post record.",
    table: "posts",
    category: "rest",
    params: [
      { name: "title", type: "string", required: true, description: "Post title", location: "body" },
      { name: "slug", type: "string", required: true, description: "URL slug", location: "body" },
      { name: "content", type: "string", required: false, description: "Post content", location: "body" },
      { name: "author_id", type: "uuid", required: true, description: "Author user ID", location: "body" },
    ],
    request_body_example: `{\n  "title": "New Post",\n  "slug": "new-post",\n  "content": "Hello!",\n  "author_id": "a1b2c3d4"\n}`,
  },
  {
    method: "GET",
    path: "/rest/v1/tags",
    summary: "List tags",
    description: "List all tags.",
    table: "tags",
    category: "rest",
    params: [],
  },
  // Auth endpoints
  {
    method: "POST",
    path: "/auth/v1/signup",
    summary: "Sign up",
    description: "Register a new user account. Sends a confirmation email if email confirmation is enabled.",
    table: "auth",
    category: "auth",
    params: [
      { name: "email", type: "string", required: true, description: "Email address", location: "body" },
      { name: "password", type: "string", required: true, description: "Password (min 6 characters)", location: "body" },
      { name: "data", type: "object", required: false, description: "User metadata object", location: "body" },
    ],
    request_body_example: `{\n  "email": "user@example.com",\n  "password": "securepassword"\n}`,
    response_example: `{\n  "access_token": "eyJ...",\n  "token_type": "bearer",\n  "expires_in": 3600,\n  "user": { "id": "uuid", "email": "user@example.com" }\n}`,
  },
  {
    method: "POST",
    path: "/auth/v1/token?grant_type=password",
    summary: "Sign in with password",
    description: "Authenticate with email and password. Returns access and refresh tokens.",
    table: "auth",
    category: "auth",
    params: [
      { name: "email", type: "string", required: true, description: "Email address", location: "body" },
      { name: "password", type: "string", required: true, description: "Password", location: "body" },
    ],
    request_body_example: `{\n  "email": "user@example.com",\n  "password": "securepassword"\n}`,
    response_example: `{\n  "access_token": "eyJ...",\n  "token_type": "bearer",\n  "expires_in": 3600,\n  "refresh_token": "abc123"\n}`,
  },
  {
    method: "POST",
    path: "/auth/v1/token?grant_type=refresh_token",
    summary: "Refresh token",
    description: "Exchange a refresh token for a new access token.",
    table: "auth",
    category: "auth",
    params: [
      { name: "refresh_token", type: "string", required: true, description: "Refresh token from sign-in", location: "body" },
    ],
  },
  {
    method: "POST",
    path: "/auth/v1/logout",
    summary: "Sign out",
    description: "Invalidate the current session. Requires Authorization header.",
    table: "auth",
    category: "auth",
    params: [],
  },
  // Storage endpoints
  {
    method: "POST",
    path: "/storage/v1/object/{bucket}/{path}",
    summary: "Upload file",
    description: "Upload a file to a storage bucket.",
    table: "storage",
    category: "storage",
    params: [
      { name: "bucket", type: "string", required: true, description: "Bucket name", location: "path" },
      { name: "path", type: "string", required: true, description: "File path within the bucket", location: "path" },
      { name: "Content-Type", type: "string", required: true, description: "MIME type of the file", location: "header" },
    ],
  },
  {
    method: "GET",
    path: "/storage/v1/object/{bucket}/{path}",
    summary: "Download file",
    description: "Download a file from a storage bucket. Public buckets allow unauthenticated access.",
    table: "storage",
    category: "storage",
    params: [
      { name: "bucket", type: "string", required: true, description: "Bucket name", location: "path" },
      { name: "path", type: "string", required: true, description: "File path within the bucket", location: "path" },
    ],
  },
]

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
  onClose,
}: {
  endpoint: ApiEndpoint
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
    const start = performance.now()

    // Mock response
    await new Promise((r) => setTimeout(r, 300))

    setResponse({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json", "x-request-id": "mock-req-id" },
      body: endpoint.response_example ?? '{"success": true}',
      duration: Math.round(performance.now() - start),
    })
    setLoading(false)
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

// ─── GraphQL Playground Tab ───────────────────────────────────────────────────

function GraphQLPlayground(): React.ReactElement {
  const [query, setQuery] = useState(
`{
  users(first: 10) {
    id
    email
    name
    posts {
      title
      status
    }
  }
}`
  )
  const [result, setResult] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleRun = async () => {
    setLoading(true)
    await new Promise((r) => setTimeout(r, 300))
    setResult(JSON.stringify({
      data: {
        users: [
          { id: "a1b2c3d4", email: "alice@example.com", name: "Alice", posts: [{ title: "Hello World", status: "published" }] },
        ],
      },
    }, null, 2))
    setLoading(false)
  }

  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <label className="block text-xs text-muted-foreground uppercase mb-1">Query</label>
        <textarea
          className="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm font-mono focus:outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 min-h-[300px] resize-y"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        <div className="flex justify-end mt-2">
          <Button variant="primary" size="sm" onClick={() => void handleRun()} disabled={loading}>
            {loading ? "Running..." : "Run Query"}
          </Button>
        </div>
      </div>
      <div>
        <label className="block text-xs text-muted-foreground uppercase mb-1">Result</label>
        {result ? (
          <CodeBlock className="min-h-[300px]">{result}</CodeBlock>
        ) : (
          <div className="min-h-[300px] rounded-md border border-border bg-background p-4 text-sm text-muted-foreground">
            Run a query to see results here
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function ApiDocs(): React.ReactElement {
  const client = useStudioClient()

  const [endpoints] = useState<ApiEndpoint[]>(mockEndpoints)
  const [activeTab, setActiveTab] = useState<"rest" | "graphql">("rest")
  const [expanded, setExpanded] = useState<string | null>(null)
  const [tryItEndpoint, setTryItEndpoint] = useState<string | null>(null)
  const [filterCategory, setFilterCategory] = useState("all")
  const [filterTable, setFilterTable] = useState("all")
  const [search, setSearch] = useState("")

  const tables = useMemo(() => [...new Set(endpoints.map((e) => e.table))], [endpoints])

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
      {/* Tab bar */}
      <div className="flex border-b border-border mb-4">
        <button
          className={cn(
            "px-4 py-2 text-sm border-b-2 transition-colors",
            activeTab === "rest" ? "text-primary border-primary" : "text-muted-foreground border-transparent hover:text-foreground"
          )}
          onClick={() => setActiveTab("rest")}
        >
          REST API
        </button>
        <button
          className={cn(
            "px-4 py-2 text-sm border-b-2 transition-colors",
            activeTab === "graphql" ? "text-primary border-primary" : "text-muted-foreground border-transparent hover:text-foreground"
          )}
          onClick={() => setActiveTab("graphql")}
        >
          GraphQL Playground
        </button>
      </div>

      {activeTab === "graphql" ? (
        <GraphQLPlayground />
      ) : (
        <>
          {/* Auth section */}
          <AuthSection />

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
              {tables.map((t) => <option key={t} value={t}>{t}</option>)}
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
