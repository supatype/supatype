import React, { useState } from "react"
import { useStudioClient } from "../StudioApp.js"
import { cn } from "../lib/utils.js"
import { Card, CodeBlock, Select, Th, Td } from "../components/ui.js"

interface ApiEndpoint {
  method: "GET" | "POST" | "PATCH" | "DELETE"
  path: string
  description: string
  table: string
  params?: Array<{ name: string; type: string; required: boolean; description: string }>
  example_response?: string
}

const mockEndpoints: ApiEndpoint[] = [
  {
    method: "GET",
    path: "/rest/v1/users",
    description: "List all users with optional filtering and pagination",
    table: "users",
    params: [
      { name: "select", type: "string", required: false, description: "Comma-separated list of columns to return" },
      { name: "order", type: "string", required: false, description: "Column to sort by (e.g. name.asc)" },
      { name: "limit", type: "integer", required: false, description: "Maximum number of rows to return" },
      { name: "offset", type: "integer", required: false, description: "Number of rows to skip" },
    ],
    example_response: `[\n  {\n    "id": "a1b2c3",\n    "email": "alice@example.com",\n    "name": "Alice",\n    "created_at": "2026-01-15T10:30:00Z"\n  }\n]`,
  },
  {
    method: "POST",
    path: "/rest/v1/users",
    description: "Create a new user",
    table: "users",
    params: [
      { name: "email", type: "string", required: true, description: "User email address" },
      { name: "name", type: "string", required: true, description: "User display name" },
    ],
  },
  {
    method: "PATCH",
    path: "/rest/v1/users",
    description: "Update users matching filter",
    table: "users",
    params: [
      { name: "id", type: "uuid", required: false, description: "Filter by user ID (eq, neq, in)" },
      { name: "name", type: "string", required: false, description: "New name value" },
    ],
  },
  {
    method: "DELETE",
    path: "/rest/v1/users",
    description: "Delete users matching filter",
    table: "users",
    params: [
      { name: "id", type: "uuid", required: true, description: "Filter by user ID" },
    ],
  },
  {
    method: "GET",
    path: "/rest/v1/posts",
    description: "List all posts with optional filtering",
    table: "posts",
    params: [
      { name: "select", type: "string", required: false, description: "Comma-separated columns (supports nested: author(name))" },
      { name: "status", type: "string", required: false, description: "Filter by status (eq.published)" },
    ],
  },
  {
    method: "POST",
    path: "/rest/v1/posts",
    description: "Create a new post",
    table: "posts",
  },
  {
    method: "GET",
    path: "/rest/v1/tags",
    description: "List all tags",
    table: "tags",
  },
  {
    method: "POST",
    path: "/auth/v1/signup",
    description: "Register a new user account",
    table: "auth",
    params: [
      { name: "email", type: "string", required: true, description: "Email address" },
      { name: "password", type: "string", required: true, description: "Password (min 6 characters)" },
    ],
  },
  {
    method: "POST",
    path: "/auth/v1/token?grant_type=password",
    description: "Sign in with email and password",
    table: "auth",
    params: [
      { name: "email", type: "string", required: true, description: "Email address" },
      { name: "password", type: "string", required: true, description: "Password" },
    ],
  },
]

const methodColorClass: Record<string, string> = {
  GET: "text-green-400",
  POST: "text-blue-400",
  PATCH: "text-yellow-400",
  DELETE: "text-red-400",
}

export function ApiDocs(): React.ReactElement {
  const client = useStudioClient()
  const [endpoints] = useState<ApiEndpoint[]>(mockEndpoints)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [filterTable, setFilterTable] = useState("all")

  const tables = [...new Set(endpoints.map((e) => e.table))]
  const filtered = filterTable === "all" ? endpoints : endpoints.filter((e) => e.table === filterTable)

  const toggleExpand = (key: string) => {
    setExpanded(expanded === key ? null : key)
  }

  return (
    <>
      <div className="flex items-center justify-end mb-4">
        <Select className="w-40" value={filterTable} onChange={(e) => setFilterTable(e.target.value)}>
          <option value="all">All endpoints</option>
          {tables.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
      </div>

      <div className="flex flex-col gap-3">
        {filtered.map((ep) => {
          const key = `${ep.method}-${ep.path}`
          const isExpanded = expanded === key
          return (
            <Card key={key}>
              <div
                onClick={() => toggleExpand(key)}
                className="flex items-center gap-3 px-4 py-3 cursor-pointer"
              >
                <span className={cn("font-mono font-bold text-xs min-w-[3.5rem]", methodColorClass[ep.method] ?? "text-foreground")}>
                  {ep.method}
                </span>
                <code className="text-[0.8rem] text-foreground">{ep.path}</code>
                <span className="ml-auto text-zinc-600 text-xs">{ep.description}</span>
              </div>

              {isExpanded ? (
                <div className="border-t border-border p-4">
                  <p className="text-muted-foreground text-[0.8rem] mb-4">{ep.description}</p>

                  {ep.params && ep.params.length > 0 ? (
                    <>
                      <h4 className="text-xs text-muted-foreground mb-2 uppercase">Parameters</h4>
                      <Card className="overflow-auto">
                        <table className="w-full">
                          <thead>
                            <tr className="border-b border-border">
                              <Th>Name</Th>
                              <Th>Type</Th>
                              <Th>Required</Th>
                              <Th>Description</Th>
                            </tr>
                          </thead>
                          <tbody>
                            {ep.params.map((p) => (
                              <tr key={p.name} className="border-b border-border hover:bg-accent/50">
                                <Td><code className="text-primary">{p.name}</code></Td>
                                <Td className="text-muted-foreground">{p.type}</Td>
                                <Td>{p.required ? <span className="text-red-400">required</span> : "optional"}</Td>
                                <Td className="text-muted-foreground">{p.description}</Td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </Card>
                    </>
                  ) : null}

                  {ep.example_response ? (
                    <div className="mt-4">
                      <h4 className="text-xs text-muted-foreground mb-2 uppercase">Example Response</h4>
                      <CodeBlock>{ep.example_response}</CodeBlock>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </Card>
          )
        })}
      </div>
    </>
  )
}
