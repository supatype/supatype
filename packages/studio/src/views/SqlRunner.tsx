import React, { useState, useCallback, useRef, useEffect } from "react"
import { EditorView, basicSetup } from "codemirror"
import { EditorState, Compartment, Prec, type Extension } from "@codemirror/state"
import { keymap } from "@codemirror/view"
import { closeCompletion } from "@codemirror/autocomplete"
import { sql as sqlLang, PostgreSQL } from "@codemirror/lang-sql"
import { useStudioClient } from "../StudioCore.js"
import { useProjectProxy } from "../hooks/useProjectProxy.js"
import { cn } from "../lib/utils.js"
import { isJsonObject, isNumber, isShape, isString, optional, safeParseJson } from "../lib/json.js"
import { Badge, Button, Card, CodeBlock, DestructiveAnswers, Dialog, DisclosureButton, Input, Select, Table, Tabs, Th, Td, type TabItem } from "../components/ui.js"
import { destructiveStatements } from "../lib/sql-destructive.js"
import { usePlatform } from "../hooks/usePlatform.js"
import { ElevatedNotice } from "../components/ElevatedModeBanner.js"
import { RoleDenied } from "../components/RoleGate.js"
import { useStudioCapability } from "../hooks/useStudioCapability.js"
import { sqlEditorOffered } from "../lib/sql-editor-access.js"
import { UuidCell } from "../components/UuidCell.js"

// ─── Destructive SQL ──────────────────────────────────────────────────────────

/**
 * Runs SQL straight away unless it drops, empties or overwrites something
 * ({@link destructiveStatements}); then it asks first, naming what it destroys, and runs only on
 * the answer. Cancel runs nothing. The text judged is the text that will run.
 */
function useDestructiveQuestion(run: (text: string) => void): { request: (text: string) => void; question: React.ReactNode } {
  const { projectRef } = usePlatform()
  const [asking, setAsking] = useState<string | null>(null)
  const request = useCallback((text: string) => {
    if (destructiveStatements(text).length === 0) run(text)
    else setAsking(text)
  }, [run])
  const question = asking === null ? null : (
    <Dialog
      role="alertdialog"
      title={`Run this SQL on ${projectRef ?? "this project"}?`}
      actions={<DestructiveAnswers label="Run SQL" act={() => { run(asking) }} onClose={() => { setAsking(null) }} />}
    >
      <p>It drops, deletes or overwrites, and cannot be undone:</p>
      <CodeBlock className="max-h-40 overflow-y-auto whitespace-pre-wrap p-2 text-xs">{destructiveStatements(asking).join(";\n")}</CodeBlock>
    </Dialog>
  )
  return { request, question }
}

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

/** A result as its tab: a failed run marked, its label and how long it took, and its close. */
function resultTab(tab: ResultTab, closeTab: (id: string) => void): TabItem<string> {
  return {
    id: tab.id,
    label: (
      <span className="flex items-center gap-2">
        {tab.error ? <span className="text-destructive-text" aria-label="failed">!</span> : null}
        <span className="truncate max-w-[150px]">{tab.label}</span>
        <span className="text-muted-foreground">{tab.duration}ms</span>
      </span>
    ),
    close: { label: `Close ${tab.label}`, onClose: () => { closeTab(tab.id) } },
  }
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

const isExplainFields = isShape({
  "Node Type": isString,
  "Relation Name": optional(isString),
  "Startup Cost": isNumber,
  "Total Cost": isNumber,
  "Plan Rows": isNumber,
  "Plan Width": isNumber,
  "Actual Startup Time": optional(isNumber),
  "Actual Total Time": optional(isNumber),
  "Actual Rows": optional(isNumber),
  "Actual Loops": optional(isNumber),
})

function isExplainNode(value: unknown): value is ExplainNode {
  if (!isJsonObject(value)) return false
  const plans = value["Plans"]
  return isExplainFields(value) && (plans === undefined || (Array.isArray(plans) && plans.every(isExplainNode)))
}

/**
 * The plan in an EXPLAIN result's first row, or null when there is none to draw.
 *
 * Only `FORMAT JSON` gives a plan to draw. A plain EXPLAIN answers with lines of text, which
 * are shown as the rows they are rather than parsed (and failing) as JSON.
 */
function explainPlanOf(row: Record<string, unknown> | undefined): ExplainNode | null {
  const raw = row?.["QUERY PLAN"]
  const parsed = typeof raw === "string" ? safeParseJson(raw) : raw
  const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined
  const plan = Array.isArray(parsed) ? (isJsonObject(first) ? first["Plan"] : undefined) : parsed
  return isExplainNode(plan) ? plan : null
}

// ─── Explain Plan Visualization ───────────────────────────────────────────────

/** One plan node's figures: its cost, its rows, its time when it ran, and a bar for its cost. */
function PlanFigures({ node }: { node: ExplainNode }): React.ReactElement {
  const costPercent = node["Total Cost"] > 0 ? Math.min(100, (node["Total Cost"] / 10) * 100) : 0
  return (
    <>
      <div className="flex gap-3 text-[0.7rem] text-muted-foreground">
        <span>cost: {node["Total Cost"].toFixed(2)}</span>
        <span>rows: {node["Actual Rows"] ?? node["Plan Rows"]}</span>
        {node["Actual Total Time"] !== undefined ? <span>time: {node["Actual Total Time"].toFixed(3)}ms</span> : null}
      </div>
      <div className="w-[60px] h-1.5 bg-border rounded-full overflow-hidden">
        <div className="h-full bg-primary rounded-full" style={{ width: `${costPercent}%` }} />
      </div>
    </>
  )
}

/**
 * A plan node and, while it is open, the nodes under it. Its row is a disclosure button, so a
 * node opens and closes from the keyboard as well as the pointer; a leaf has nothing to open.
 */
function ExplainPlanTree({ node, depth = 0 }: { node: ExplainNode; depth?: number }): React.ReactElement {
  const [expanded, setExpanded] = useState(true)
  const children = node.Plans ?? []
  return (
    <div className={cn("border-l-2 border-border", depth > 0 && "ml-4")}>
      <DisclosureButton open={children.length > 0 ? expanded : undefined} className="px-3 py-2" onClick={() => setExpanded(!expanded)}>
        <span className="text-zinc-500 text-xs w-[24px]">{children.length > 0 ? (expanded ? "[-]" : "[+]") : null}</span>
        <Badge variant="indigo">{node["Node Type"]}</Badge>
        {node["Relation Name"] ? <code className="text-primary text-xs">{node["Relation Name"]}</code> : null}
        <div className="flex-1" />
        <PlanFigures node={node} />
      </DisclosureButton>
      {expanded && children.length > 0 ? (
        <div>{children.map((child, i) => <ExplainPlanTree key={i} node={child} depth={depth + 1} />)}</div>
      ) : null}
    </div>
  )
}

// ─── CodeMirror theme ─────────────────────────────────────────────────────────

const studioSqlTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "hsl(var(--foreground))",
    fontSize: "0.8125rem",
    fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
  },
  ".cm-scroller": { minHeight: "140px", overflowY: "auto" },
  ".cm-content": { padding: "12px 16px", caretColor: "hsl(var(--primary))" },
  ".cm-cursor": { borderLeftColor: "hsl(var(--primary))" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "hsl(var(--accent))",
  },
  ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.04)" },
  ".cm-gutters": {
    backgroundColor: "hsl(var(--accent) / 0.3)",
    color: "hsl(var(--muted-foreground))",
    borderRight: "1px solid hsl(var(--border))",
    fontSize: "0.7rem",
    minWidth: "2.5rem",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 4px" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-tooltip": {
    backgroundColor: "hsl(var(--popover))",
    border: "1px solid hsl(var(--border))",
    borderRadius: "6px",
    color: "hsl(var(--popover-foreground))",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { maxHeight: "14em" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "hsl(var(--accent))",
    color: "hsl(var(--accent-foreground))",
  },
  ".cm-completionLabel": { color: "hsl(var(--foreground))" },
  ".cm-completionDetail": {
    color: "hsl(var(--muted-foreground))",
    fontStyle: "italic",
    marginLeft: "0.5em",
  },
  ".cm-completionIcon": { opacity: "0.6" },
}, { dark: true })

// ─── SQL Editor ───────────────────────────────────────────────────────────────

/**
 * Close the autocomplete list, which otherwise stays open over the editor, then run. Both ways of
 * running come here: Mod-Enter in the editor and the Run Query button beside it.
 */
export function runAndCloseCompletion(view: EditorView, run: () => void): boolean {
  closeCompletion(view)
  run()
  return true
}

/** The query text and its setter. */
interface SqlEditorDoc {
  value: string
  onChange: (v: string) => void
}

/** How the page runs the query, and where it keeps the editor so its own Run button can close the list. */
interface SqlEditorControl {
  onRun: () => void
  viewRef: React.MutableRefObject<EditorView | null>
}

/** The latest run and change handlers, read when a key is pressed or the text changes. */
interface SqlEditorListeners {
  onRun: React.RefObject<() => void>
  onChange: React.RefObject<(v: string) => void>
}

/** The SQL editor's extensions: Studio's setup and theme, SQL completion, Mod-Enter to run, and the listener. */
function sqlEditorExtensions(completion: Compartment, listeners: SqlEditorListeners): Extension[] {
  return [
    basicSetup,
    studioSqlTheme,
    completion.of(sqlLang({ dialect: PostgreSQL, schema: {}, defaultSchema: "public" })),
    // Highest, or basicSetup's own Mod-Enter (insert a blank line) answers first and the
    // query never runs: the "Ctrl+Enter to run" hint under the editor did nothing.
    Prec.highest(keymap.of([{ key: "Mod-Enter", run: (view) => runAndCloseCompletion(view, listeners.onRun.current) }])),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) listeners.onChange.current(update.state.doc.toString())
    }),
  ]
}

/** Keeps the editor in step with the page: text set from outside (history), and the schema for completion. */
function useEditorSync(viewRef: React.RefObject<EditorView | null>, synced: { value: string; schema: Record<string, string[]>; completion: Compartment }): void {
  const { value, schema, completion } = synced
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])
  useEffect(() => {
    viewRef.current?.dispatch({ effects: completion.reconfigure(sqlLang({ dialect: PostgreSQL, schema, defaultSchema: "public" })) })
  }, [schema])
}

function SqlEditor({ doc, schema, control }: { doc: SqlEditorDoc; schema: Record<string, string[]>; control: SqlEditorControl }): React.ReactElement {
  const { value, onChange } = doc
  const { onRun, viewRef } = control
  const containerRef = useRef<HTMLDivElement>(null)
  const onRunRef = useRef(onRun)
  const onChangeRef = useRef(onChange)
  const completion = useRef(new Compartment())
  useEffect(() => { onRunRef.current = onRun }, [onRun])
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  // Created once on mount: the ref object never changes.
  useEffect(() => {
    if (!containerRef.current) return
    const extensions = sqlEditorExtensions(completion.current, { onRun: onRunRef, onChange: onChangeRef })
    const view = new EditorView({ state: EditorState.create({ doc: value, extensions }), parent: containerRef.current })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
  }, [viewRef])
  useEditorSync(viewRef, { value, schema, completion: completion.current })

  return <div ref={containerRef} className="rounded-md border border-border bg-background overflow-hidden" />
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

/**
 * The SQL editor, for the roles offered it (RX1): owners, admins and developers. It runs as
 * supatype_sql_editor, which holds the owning role's rights, so row level security does not apply. Anyone else who opens its URL
 * is told why there is nothing here rather than shown an editor whose every query is refused.
 */
export function SqlRunner(): React.ReactElement {
  const capability = useStudioCapability()
  if (!sqlEditorOffered(capability)) {
    return <RoleDenied role={capability.role} needs="sqlEditor" activity="use the SQL editor" />
  }
  // Its own notice, not the acting-mode banner: the editor is elevated whatever mode the caller's
  // data requests act in, so the banner would say "acting as yourself" over rows that are not.
  return (
    <>
      <SqlEditorAccessNotice />
      <SqlEditorView />
    </>
  )
}

/** What the editor's queries run as, over the editor. */
export function SqlEditorAccessNotice(): React.ReactElement {
  return (
    <ElevatedNotice>
      <span>
        <strong className="font-medium">Full access</strong>: queries run as{" "}
        <code>supatype_sql_editor</code>, which holds the rights of the role that owns the project&apos;s
        tables, so Row Level Security does not apply to them and masked columns show in full. It is not a
        superuser. Every query is recorded.
      </span>
    </ElevatedNotice>
  )
}

function SqlEditorView(): React.ReactElement {
  const client = useStudioClient()
  const { sql, introspect } = useProjectProxy()

  const [query, setQuery] = useState("SELECT * FROM auth.users LIMIT 10;")
  const [running, setRunning] = useState(false)
  const [sqlSchema, setSqlSchema] = useState<Record<string, string[]>>({})

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

  // Load schema for autocomplete (public + auth schemas)
  useEffect(() => {
    void (async () => {
      try {
        const [publicTables, authTables] = await Promise.all([
          introspect("public"),
          introspect("auth").catch(() => []),
        ])
        const map: Record<string, string[]> = {}
        for (const t of [...publicTables, ...authTables]) {
          const cols = t.columns.map((c) => c.name)
          map[t.name] = cols
          map[`${t.schema}.${t.name}`] = cols
        }
        setSqlSchema(map)
      } catch {
        // editor works fine without schema, autocomplete just shows keywords
      }
    })()
  }, [introspect])

  const handleRun = useCallback(async (text: string) => {
    if (!text.trim() || running) return
    setRunning(true)
    const start = performance.now()

    try {
      const result = await sql(text)
      const elapsed = Math.round(performance.now() - start)

      const rows = result.rows
      const columns = rows.length > 0 ? Object.keys(rows[0]!) : []

      let explainPlan: ExplainNode | null = null
      if (text.trim().toUpperCase().startsWith("EXPLAIN")) {
        explainPlan = explainPlanOf(rows[0])
      }

      const tabId = `tab-${Date.now()}`
      const newTab: ResultTab = {
        id: tabId,
        label: text.trim().slice(0, 30) + (text.trim().length > 30 ? "..." : ""),
        query: text.trim(),
        columns,
        rows,
        duration: elapsed,
        error: null,
        explainPlan,
      }

      setTabs((prev) => [...prev, newTab])
      setActiveTabId(tabId)
      setHistory((prev) => [
        { id: `h-${Date.now()}`, query: text.trim(), timestamp: Date.now(), duration: elapsed, rows: rows.length, error: null },
        ...prev.slice(0, 49),
      ])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const elapsed = Math.round(performance.now() - start)
      const tabId = `tab-${Date.now()}`
      const newTab: ResultTab = {
        id: tabId,
        label: "Error",
        query: text.trim(),
        columns: [],
        rows: [],
        duration: elapsed,
        error: msg,
        explainPlan: null,
      }
      setTabs((prev) => [...prev, newTab])
      setActiveTabId(tabId)
      setHistory((prev) => [
        { id: `h-${Date.now()}`, query: text.trim(), timestamp: Date.now(), duration: elapsed, rows: 0, error: msg },
        ...prev.slice(0, 49),
      ])
    } finally {
      setRunning(false)
    }
  }, [running, sql])

  const editorRef = useRef<EditorView | null>(null)
  const confirm = useDestructiveQuestion((text) => { void handleRun(text) })
  const runQuery = useCallback(() => { confirm.request(query) }, [confirm.request, query])
  const runFromButton = (): void => {
    const view = editorRef.current
    if (view === null) runQuery()
    else runAndCloseCompletion(view, runQuery)
  }

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
          <SqlEditor
            doc={{ value: query, onChange: setQuery }}
            schema={sqlSchema}
            control={{ onRun: runQuery, viewRef: editorRef }}
          />

          <div className="flex justify-between items-center mt-3">
            <span className="text-xs text-zinc-600">
              {navigator.platform.includes("Mac") ? "⌘↵" : "Ctrl+Enter"} to run
            </span>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setShowHistory(!showHistory)}>
                History ({history.length})
              </Button>
              <Button size="sm" variant="primary" onClick={runFromButton} disabled={running}>
                {running ? "Running..." : "Run Query"}
              </Button>
            </div>
          </div>
        </Card>

        {confirm.question}

        {/* Result Tabs */}
        {tabs.length > 0 ? (
          <div>
            {/* Tab bar */}
            <Tabs
              tabs={{ label: "Query results", size: "xs", items: tabs.map((tab) => resultTab(tab, closeTab)) }}
              value={activeTabId ?? ""}
              onChange={setActiveTabId}
            />

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
                      <Table>
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
                                    <UuidCell value={String(row[col])} />
                                  )}
                                </Td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </Table>
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
