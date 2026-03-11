import React, { useState } from "react"
import { useStudioClient } from "../StudioApp.js"
import { Button, Card, Th, Td } from "../components/ui.js"

interface QueryHistoryEntry {
  query: string
  timestamp: number
  duration: number
  rows: number
  error: string | null
}

export function SqlRunner(): React.ReactElement {
  const client = useStudioClient()
  const [query, setQuery] = useState("SELECT * FROM users LIMIT 10;")
  const [results, setResults] = useState<Record<string, unknown>[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [duration, setDuration] = useState<number | null>(null)
  const [history, setHistory] = useState<QueryHistoryEntry[]>([])
  const [showHistory, setShowHistory] = useState(false)

  const handleRun = async () => {
    if (!query.trim()) return
    setRunning(true)
    setError(null)
    setResults(null)
    const start = performance.now()

    try {
      await new Promise((r) => setTimeout(r, 200))
      const elapsed = Math.round(performance.now() - start)
      setDuration(elapsed)

      const mockResult = [
        { id: "a1b2c3", email: "alice@example.com", name: "Alice", created_at: "2026-01-15T10:30:00Z" },
        { id: "d4e5f6", email: "bob@example.com", name: "Bob", created_at: "2026-02-01T14:20:00Z" },
      ]
      setResults(mockResult)
      setHistory((prev) => [{ query, timestamp: Date.now(), duration: elapsed, rows: mockResult.length, error: null }, ...prev.slice(0, 49)])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setDuration(Math.round(performance.now() - start))
      setHistory((prev) => [{ query, timestamp: Date.now(), duration: Math.round(performance.now() - start), rows: 0, error: msg }, ...prev.slice(0, 49)])
    } finally {
      setRunning(false)
    }
  }

  const columns = results && results.length > 0 ? Object.keys(results[0]!) : []

  return (
    <div className="space-y-4">
      {/* Query editor */}
      <Card className="p-4">
        <textarea
          className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-foreground text-sm font-mono focus:outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 min-h-[120px] resize-y"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Enter SQL query..."
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault()
              void handleRun()
            }
          }}
        />
        <div className="flex justify-between items-center mt-3">
          <span className="text-xs text-zinc-600">Ctrl+Enter to run</span>
          <div className="flex gap-2">
            <Button onClick={() => setShowHistory(!showHistory)}>
              History ({history.length})
            </Button>
            <Button variant="primary" onClick={() => void handleRun()} disabled={running}>
              {running ? "Running..." : "Run Query"}
            </Button>
          </div>
        </div>
      </Card>

      {/* Error */}
      {error ? (
        <div className="rounded-lg border border-destructive bg-card p-4">
          <div className="text-red-400 font-mono text-[0.8rem] whitespace-pre-wrap">{error}</div>
        </div>
      ) : null}

      {/* Results */}
      {results ? (
        <Card className="overflow-auto">
          <div className="px-3 py-2 border-b border-border flex justify-between text-[0.8rem] text-muted-foreground">
            <span>{results.length} row{results.length !== 1 ? "s" : ""}</span>
            {duration !== null ? <span>{duration}ms</span> : null}
          </div>
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                {columns.map((col) => <Th key={col}>{col}</Th>)}
              </tr>
            </thead>
            <tbody>
              {results.map((row, i) => (
                <tr key={i} className="border-b border-border hover:bg-accent/50">
                  {columns.map((col) => (
                    <Td key={col}>
                      {row[col] === null ? <span className="text-zinc-600 italic">NULL</span> : String(row[col])}
                    </Td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {/* History panel */}
      {showHistory ? (
        <Card className="p-4">
          <h3>Query History</h3>
          {history.length === 0 ? (
            <p className="text-zinc-600 text-[0.8rem]">No queries yet</p>
          ) : (
            <div>
              {history.map((entry, i) => (
                <div
                  key={i}
                  className="py-2 border-b border-border cursor-pointer hover:bg-accent/50"
                  onClick={() => { setQuery(entry.query); setShowHistory(false) }}
                >
                  <code className="text-xs text-primary">{entry.query.slice(0, 100)}{entry.query.length > 100 ? "..." : ""}</code>
                  <div className="text-[0.7rem] text-zinc-600 mt-1">
                    {new Date(entry.timestamp).toLocaleTimeString()} · {entry.duration}ms · {entry.rows} rows
                    {entry.error ? <span className="text-red-400"> · Error</span> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : null}
    </div>
  )
}
