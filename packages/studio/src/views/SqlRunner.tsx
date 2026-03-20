import React, { useState, useCallback, useRef, useEffect } from "react"
import { useStudioClient } from "../StudioApp.js"
import { cn } from "../lib/utils.js"
import { Badge, Button, Card, CodeBlock, Input, Select, Th, Td } from "../components/ui.js"

// ─── Types ────────────────────────────────────────────────────────────────────

interface QueryHistoryEntry {
  id: string
  query: string
  timestamp: number
  duration: number
  rows: number
  error: string | null
}

interface ResultTab {
  id: string
  label: string
  query: string
  columns: string[]
  rows: Record<string, unknown>[]
  duration: number
  error: string | null
  explainPlan: ExplainNode | null
}

interface ExplainNode {
  "Node Type": string
  "Relation Name"?: string
  "Startup Cost": number
  "Total Cost": number
  "Plan Rows": number
  "Plan Width": number
  "Actual Startup Time"?: number
  "Actual Total Time"?: number
  "Actual Rows"?: number
  "Actual Loops"?: number
  Plans?: ExplainNode[]
  [key: string]: unknown
}

// ─── SQL Keywords for Syntax Hints ────────────────────────────────────────────

const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
  "DELETE", "CREATE", "ALTER", "DROP", "TABLE", "INDEX", "VIEW", "FUNCTION",
  "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "CROSS", "FULL", "ON",
  "AND", "OR", "NOT", "IN", "EXISTS", "BETWEEN", "LIKE", "ILIKE",
  "ORDER", "BY", "ASC", "DESC", "LIMIT", "OFFSET", "GROUP", "HAVING",
  "DISTINCT", "AS", "CASE", "WHEN", "THEN", "ELSE", "END",
  "NULL", "TRUE", "FALSE", "IS", "COALESCE", "NULLIF",
  "COUNT", "SUM", "AVG", "MIN", "MAX", "ARRAY_AGG", "STRING_AGG",
  "WITH", "RECURSIVE", "RETURNING", "EXPLAIN", "ANALYZE",
  "BEGIN", "COMMIT", "ROLLBACK", "GRANT", "REVOKE",
  "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "UNIQUE", "CHECK", "DEFAULT",
  "CONSTRAINT", "CASCADE", "RESTRICT", "ENABLE", "DISABLE", "ROW", "LEVEL", "SECURITY",
  "POLICY", "USING", "TRIGGER", "BEFORE", "AFTER", "FOR", "EACH", "EXECUTE", "PROCEDURE",
]

// ─── Mock Explain Plan ────────────────────────────────────────────────────────

const mockExplainPlan: ExplainNode = {
  "Node Type": "Limit",
  "Startup Cost": 0.00,
  "Total Cost": 1.24,
  "Plan Rows": 10,
  "Plan Width": 128,
  "Actual Startup Time": 0.012,
  "Actual Total Time": 0.054,
  "Actual Rows": 2,
  "Actual Loops": 1,
  Plans: [
    {
      "Node Type": "Seq Scan",
      "Relation Name": "users",
      "Startup Cost": 0.00,
      "Total Cost": 1.42,
      "Plan Rows": 42,
      "Plan Width": 128,
      "Actual Startup Time": 0.010,
      "Actual Total Time": 0.048,
      "Actual Rows": 2,
      "Actual Loops": 1,
    },
  ],
}

// ─── Explain Plan Visualization ───────────────────────────────────────────────

function ExplainPlanTree({
  node,
  depth = 0,
}: {
  node: ExplainNode
  depth?: number
}): React.ReactElement {
  const [expanded, setExpanded] = useState(true)
  const hasChildren = node.Plans && node.Plans.length > 0
  const costPercent = node["Total Cost"] > 0 ? Math.min(100, (node["Total Cost"] / 10) * 100) : 0

  return (
    <div className={cn("border-l-2 border-border", depth > 0 && "ml-4")}>
      <div
        className="flex items-center gap-2 px-3 py-2 hover:bg-accent/50 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {hasChildren ? (
          <span className="text-zinc-500 text-xs">{expanded ? "[-]" : "[+]"}</span>
        ) : (
          <span className="text-zinc-600 text-xs w-[24px]" />
        )}

        <Badge variant="indigo">{node["Node Type"]}</Badge>

        {node["Relation Name"] ? (
          <code className="text-primary text-xs">{node["Relation Name"]}</code>
        ) : null}

        <div className="flex-1" />

        <div className="flex gap-3 text-[0.7rem] text-muted-foreground">
          <span>cost: {node["Total Cost"].toFixed(2)}</span>
          <span>rows: {node["Actual Rows"] ?? node["Plan Rows"]}</span>
          {node["Actual Total Time"] !== undefined ? (
            <span>time: {node["Actual Total Time"].toFixed(3)}ms</span>
          ) : null}
        </div>

        {/* Cost bar */}
        <div className="w-[60px] h-1.5 bg-border rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full"
            style={{ width: `${costPercent}%` }}
          />
        </div>
      </div>

      {expanded && hasChildren ? (
        <div>
          {node.Plans!.map((child, i) => (
            <ExplainPlanTree key={i} node={child} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ─── SQL Editor with Syntax Hints ─────────────────────────────────────────────

function SqlEditor({
  value,
  onChange,
  onRun,
}: {
  value: string
  onChange: (v: string) => void
  onRun: () => void
}): React.ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [lineCount, setLineCount] = useState(1)

  useEffect(() => {
    setLineCount(value.split("\n").length)
  }, [value])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl+Enter to run
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault()
      onRun()
      return
    }

    // Tab to indent
    if (e.key === "Tab") {
      e.preventDefault()
      const textarea = e.currentTarget
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const newValue = value.substring(0, start) + "  " + value.substring(end)
      onChange(newValue)
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2
      })
    }
  }

  return (
    <div className="flex rounded-md border border-border bg-background overflow-hidden font-mono text-sm">
      {/* Line numbers */}
      <div className="bg-accent/30 text-zinc-600 text-right px-2 py-3 select-none border-r border-border text-[0.75rem] leading-[1.5rem]">
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>

      {/* Editor */}
      <textarea
        ref={textareaRef}
        className="flex-1 px-3 py-3 bg-transparent text-foreground focus:outline-none resize-y min-h-[140px] leading-[1.5rem]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Enter SQL query..."
        spellCheck={false}
      />
    </div>
  )
}

// ─── Export Utilities ─────────────────────────────────────────────────────────

function exportCsv(columns: string[], rows: Record<string, unknown>[]): void {
  const header = columns.join(",")
  const body = rows.map((row) =>
    columns.map((col) => {
      const val = row[col]
      if (val === null || val === undefined) return ""
      const str = String(val)
      return str.includes(",") || str.includes('"') || str.includes("\n")
        ? `"${str.replace(/"/g, '""')}"`
        : str
    }).join(",")
  ).join("\n")

  const csv = `${header}\n${body}`
  const blob = new Blob([csv], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `query-results-${Date.now()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function exportJson(rows: Record<string, unknown>[]): void {
  const json = JSON.stringify(rows, null, 2)
  const blob = new Blob([json], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `query-results-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function SqlRunner(): React.ReactElement {
  const client = useStudioClient()

  const [query, setQuery] = useState("SELECT * FROM users LIMIT 10;")
  const [running, setRunning] = useState(false)

  // Result tabs
  const [tabs, setTabs] = useState<ResultTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)

  // History
  const [history, setHistory] = useState<QueryHistoryEntry[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [historySearch, setHistorySearch] = useState("")

  // Current tab
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  // Filtered history
  const filteredHistory = historySearch
    ? history.filter((h) => h.query.toLowerCase().includes(historySearch.toLowerCase()))
    : history

  const handleRun = useCallback(async () => {
    if (!query.trim() || running) return
    setRunning(true)
    const start = performance.now()

    try {
      // TODO: Replace with actual PostgREST SQL execution via admin client
      await new Promise((r) => setTimeout(r, 200))
      const elapsed = Math.round(performance.now() - start)

      const mockResult = [
        { id: "a1b2c3", email: "alice@example.com", name: "Alice", created_at: "2026-01-15T10:30:00Z" },
        { id: "d4e5f6", email: "bob@example.com", name: "Bob", created_at: "2026-02-01T14:20:00Z" },
      ]

      const tabId = `tab-${Date.now()}`
      const columns = mockResult.length > 0 ? Object.keys(mockResult[0]!) : []
      const newTab: ResultTab = {
        id: tabId,
        label: query.trim().slice(0, 30) + (query.trim().length > 30 ? "..." : ""),
        query: query.trim(),
        columns,
        rows: mockResult,
        duration: elapsed,
        error: null,
        explainPlan: query.trim().toUpperCase().startsWith("EXPLAIN") ? mockExplainPlan : null,
      }

      setTabs((prev) => [...prev, newTab])
      setActiveTabId(tabId)
      setHistory((prev) => [
        { id: `h-${Date.now()}`, query: query.trim(), timestamp: Date.now(), duration: elapsed, rows: mockResult.length, error: null },
        ...prev.slice(0, 49),
      ])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const elapsed = Math.round(performance.now() - start)
      const tabId = `tab-${Date.now()}`
      const newTab: ResultTab = {
        id: tabId,
        label: "Error",
        query: query.trim(),
        columns: [],
        rows: [],
        duration: elapsed,
        error: msg,
        explainPlan: null,
      }
      setTabs((prev) => [...prev, newTab])
      setActiveTabId(tabId)
      setHistory((prev) => [
        { id: `h-${Date.now()}`, query: query.trim(), timestamp: Date.now(), duration: elapsed, rows: 0, error: msg },
        ...prev.slice(0, 49),
      ])
    } finally {
      setRunning(false)
    }
  }, [query, running])

  const closeTab = (tabId: string) => {
    setTabs((prev) => prev.filter((t) => t.id !== tabId))
    if (activeTabId === tabId) {
      setActiveTabId(tabs.length > 1 ? tabs[tabs.length - 2]?.id ?? null : null)
    }
  }

  return (
    <div className="flex gap-4 h-full">
      {/* History sidebar */}
      {showHistory ? (
        <div className="w-[280px] flex-shrink-0">
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm font-medium">Query History</span>
            <Button size="xs" onClick={() => setShowHistory(false)}>Close</Button>
          </div>
          <Input
            placeholder="Search history..."
            value={historySearch}
            onChange={(e) => setHistorySearch(e.target.value)}
            className="mb-2"
          />
          <Card className="p-1 max-h-[calc(100vh-240px)] overflow-y-auto">
            {filteredHistory.length === 0 ? (
              <p className="text-zinc-600 text-xs px-3 py-4">No queries in history</p>
            ) : (
              filteredHistory.map((entry) => (
                <div
                  key={entry.id}
                  className="px-3 py-2 border-b border-border cursor-pointer hover:bg-accent/50 rounded-sm"
                  onClick={() => { setQuery(entry.query); setShowHistory(false) }}
                >
                  <code className="text-[0.7rem] text-primary block truncate">{entry.query}</code>
                  <div className="flex gap-2 text-[0.65rem] text-zinc-600 mt-1">
                    <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                    <span>{entry.duration}ms</span>
                    <span>{entry.rows} rows</span>
                    {entry.error ? <span className="text-red-400">Error</span> : null}
                  </div>
                </div>
              ))
            )}
          </Card>
        </div>
      ) : null}

      {/* Main editor + results */}
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        {/* SQL Editor */}
        <Card className="p-4">
          <SqlEditor value={query} onChange={setQuery} onRun={() => void handleRun()} />

          <div className="flex justify-between items-center mt-3">
            <span className="text-xs text-zinc-600">
              {navigator.platform.includes("Mac") ? "Cmd" : "Ctrl"}+Enter to run
            </span>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setShowHistory(!showHistory)}>
                History ({history.length})
              </Button>
              <Button size="sm" variant="primary" onClick={() => void handleRun()} disabled={running}>
                {running ? "Running..." : "Run Query"}
              </Button>
            </div>
          </div>
        </Card>

        {/* Result Tabs */}
        {tabs.length > 0 ? (
          <div>
            {/* Tab bar */}
            <div className="flex border-b border-border overflow-x-auto">
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 text-xs border-b-2 cursor-pointer whitespace-nowrap",
                    activeTabId === tab.id
                      ? "text-foreground border-primary"
                      : "text-muted-foreground border-transparent hover:text-foreground"
                  )}
                  onClick={() => setActiveTabId(tab.id)}
                >
                  {tab.error ? <span className="text-red-400">!</span> : null}
                  <span className="truncate max-w-[150px]">{tab.label}</span>
                  <span className="text-zinc-600">{tab.duration}ms</span>
                  <button
                    className="text-zinc-600 hover:text-foreground ml-1"
                    onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
                  >
                    x
                  </button>
                </div>
              ))}
            </div>

            {/* Active tab content */}
            {activeTab ? (
              <div className="mt-3">
                {/* Error display */}
                {activeTab.error ? (
                  <div className="rounded-lg border border-destructive bg-card p-4 mb-3">
                    <div className="text-red-400 font-mono text-[0.8rem] whitespace-pre-wrap">
                      {activeTab.error}
                    </div>
                  </div>
                ) : null}

                {/* Explain plan */}
                {activeTab.explainPlan ? (
                  <Card className="mb-3">
                    <div className="px-3 py-2 border-b border-border text-xs text-muted-foreground uppercase font-medium">
                      Execution Plan
                    </div>
                    <ExplainPlanTree node={activeTab.explainPlan} />
                  </Card>
                ) : null}

                {/* Results table */}
                {activeTab.rows.length > 0 ? (
                  <>
                    <Card className="overflow-auto">
                      <div className="px-3 py-2 border-b border-border flex justify-between items-center text-[0.8rem] text-muted-foreground">
                        <span>{activeTab.rows.length} row{activeTab.rows.length !== 1 ? "s" : ""}</span>
                        <div className="flex gap-2">
                          <Button
                            size="xs"
                            onClick={() => exportCsv(activeTab.columns, activeTab.rows)}
                          >
                            Export CSV
                          </Button>
                          <Button
                            size="xs"
                            onClick={() => exportJson(activeTab.rows)}
                          >
                            Export JSON
                          </Button>
                        </div>
                      </div>
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-border">
                            {activeTab.columns.map((col) => (
                              <Th key={col}>{col}</Th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {activeTab.rows.map((row, i) => (
                            <tr key={i} className="border-b border-border hover:bg-accent/50">
                              {activeTab.columns.map((col) => (
                                <Td key={col}>
                                  {row[col] === null ? (
                                    <span className="text-zinc-600 italic">NULL</span>
                                  ) : typeof row[col] === "object" ? (
                                    <code className="text-xs text-primary">
                                      {JSON.stringify(row[col])}
                                    </code>
                                  ) : (
                                    String(row[col])
                                  )}
                                </Td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </Card>
                  </>
                ) : !activeTab.error ? (
                  <div className="text-sm text-muted-foreground text-center py-6">
                    Query executed successfully. No rows returned.
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
