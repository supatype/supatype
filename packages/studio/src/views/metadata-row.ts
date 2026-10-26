/**
 * Reading a column from a row the database returned (`SqlResult.rows`), whose values are `unknown`.
 *
 * The Database and Storage views render catalogue rows. The query, not the program, decides each
 * column's type, so a column is read as what it is rather than cast to what it ought to be.
 */
type Row = Record<string, unknown>

/** The column as text, or null when the column is null or absent. */
export function cellTextOrNull(row: Row, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  return JSON.stringify(value)
}

/** The column as text: empty when the column is null or absent. */
export function cellText(row: Row, key: string): string {
  return cellTextOrNull(row, key) ?? ""
}

/** The column as a number. A bigint column arrives as its text, so a numeric string counts. */
export function cellNumber(row: Row, key: string): number {
  const value = row[key]
  if (typeof value === "number") return value
  return typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN
}
