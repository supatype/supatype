import React, { useState } from "react"
import { useStudioClient } from "../StudioApp.js"
import { Button, Card, CodeBlock, Input, Th, Td } from "../components/ui.js"

interface TableInfo {
  name: string
  row_count: number
}

const mockTables: TableInfo[] = [
  { name: "users", row_count: 42 },
  { name: "posts", row_count: 156 },
  { name: "tags", row_count: 12 },
  { name: "post_tags", row_count: 89 },
]

const mockRows: Record<string, unknown>[] = [
  { id: "a1b2c3", email: "alice@example.com", name: "Alice", created_at: "2026-01-15T10:30:00Z" },
  { id: "d4e5f6", email: "bob@example.com", name: "Bob", created_at: "2026-02-01T14:20:00Z" },
  { id: "g7h8i9", email: "carol@example.com", name: "Carol", created_at: "2026-02-14T09:15:00Z" },
  { id: "j0k1l2", email: "dave@example.com", name: "Dave", created_at: "2026-03-01T16:45:00Z" },
]

export function DataExplorer(): React.ReactElement {
  const client = useStudioClient()
  const [tables] = useState<TableInfo[]>(mockTables)
  const [selectedTable, setSelectedTable] = useState(mockTables[0]?.name ?? "")
  const [rows, setRows] = useState<Record<string, unknown>[]>(mockRows)
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState("")
  const [sortColumn, setSortColumn] = useState<string | null>(null)
  const [sortAsc, setSortAsc] = useState(true)
  const [editingCell, setEditingCell] = useState<{ row: number; col: string } | null>(null)
  const [editValue, setEditValue] = useState("")
  const [viewMode, setViewMode] = useState<"table" | "json">("table")
  const [selectedRow, setSelectedRow] = useState<Record<string, unknown> | null>(null)

  const pageSize = 25
  const columns = rows.length > 0 ? Object.keys(rows[0]!) : []

  const filteredRows = search
    ? rows.filter((r) => Object.values(r).some((v) => String(v).toLowerCase().includes(search.toLowerCase())))
    : rows

  const sortedRows = sortColumn
    ? [...filteredRows].sort((a, b) => {
        const va = String(a[sortColumn] ?? "")
        const vb = String(b[sortColumn] ?? "")
        return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va)
      })
    : filteredRows

  const pagedRows = sortedRows.slice(page * pageSize, (page + 1) * pageSize)
  const totalPages = Math.ceil(sortedRows.length / pageSize)

  const handleSort = (col: string) => {
    if (sortColumn === col) {
      setSortAsc(!sortAsc)
    } else {
      setSortColumn(col)
      setSortAsc(true)
    }
  }

  const handleCellEdit = (rowIdx: number, col: string) => {
    const row = pagedRows[rowIdx]
    if (!row) return
    setEditingCell({ row: rowIdx, col })
    setEditValue(String(row[col] ?? ""))
  }

  const handleCellSave = () => {
    if (!editingCell) return
    setEditingCell(null)
  }

  const formatCellValue = (value: unknown): string => {
    if (value === null || value === undefined) return "NULL"
    if (typeof value === "object") return JSON.stringify(value)
    return String(value)
  }

  return (
    <div className="grid grid-cols-[200px_1fr] gap-4">
      {/* Table list */}
      <Card className="p-2 flex flex-col gap-0.5">
        {tables.map((t) => (
          <button
            key={t.name}
            className={`flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground rounded-md transition-colors${t.name === selectedTable ? " bg-accent text-foreground font-medium" : ""}`}
            onClick={() => { setSelectedTable(t.name); setPage(0) }}
          >
            {t.name}
            <span className="ml-auto text-zinc-600 text-[0.7rem]">{t.row_count}</span>
          </button>
        ))}
      </Card>

      {/* Data view */}
      <div>
        {/* Toolbar */}
        <div className="flex gap-2 mb-3">
          <Button
            variant={viewMode === "table" ? "primary" : "secondary"}
            onClick={() => setViewMode("table")}
          >Table</Button>
          <Button
            variant={viewMode === "json" ? "primary" : "secondary"}
            onClick={() => setViewMode("json")}
          >JSON</Button>
        </div>

        {/* Search bar */}
        <div className="mb-4 flex gap-2">
          <Input
            placeholder={`Search ${selectedTable}...`}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0) }}
          />
          <Button variant="primary">+ Insert Row</Button>
        </div>

        {viewMode === "table" ? (
          <Card className="overflow-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {columns.map((col) => (
                    <Th
                      key={col}
                      onClick={() => handleSort(col)}
                      className="cursor-pointer select-none"
                    >
                      {col} {sortColumn === col ? (sortAsc ? "\u2191" : "\u2193") : ""}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((row, i) => (
                  <tr key={i} className="border-b border-border hover:bg-accent/50">
                    {columns.map((col) => (
                      <Td
                        key={col}
                        onDoubleClick={() => handleCellEdit(i, col)}
                        onClick={() => setSelectedRow(row)}
                        className="cursor-pointer"
                      >
                        {editingCell?.row === i && editingCell.col === col ? (
                          <Input
                            className="w-full px-1.5 py-0.5 text-xs"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={handleCellSave}
                            onKeyDown={(e) => { if (e.key === "Enter") handleCellSave(); if (e.key === "Escape") setEditingCell(null) }}
                            autoFocus
                          />
                        ) : (
                          <span className={`text-[0.8rem]${row[col] === null ? " text-zinc-600 italic" : ""}`}>
                            {formatCellValue(row[col])}
                          </span>
                        )}
                      </Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ) : (
          <CodeBlock>{JSON.stringify(pagedRows, null, 2)}</CodeBlock>
        )}

        {/* Pagination */}
        {totalPages > 1 ? (
          <div className="flex items-center gap-3 mt-3">
            <Button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}>Prev</Button>
            <span className="text-[0.8rem] text-muted-foreground">Page {page + 1} of {totalPages}</span>
            <Button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1}>Next</Button>
          </div>
        ) : null}

        {/* Record inspector */}
        {selectedRow ? (
          <Card className="p-4 mt-4">
            <div className="flex justify-between items-center mb-3">
              <h3 className="m-0">Record Inspector</h3>
              <Button onClick={() => setSelectedRow(null)}>Close</Button>
            </div>
            <CodeBlock>{JSON.stringify(selectedRow, null, 2)}</CodeBlock>
          </Card>
        ) : null}
      </div>
    </div>
  )
}
