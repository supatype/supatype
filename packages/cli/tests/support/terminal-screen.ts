/**
 * What a terminal shows after it is sent `text`: the cursor moves, line erases and screen clears
 * Ink writes are applied, colours and cursor visibility are dropped. Enough of a terminal to tell
 * a line drawn once from a line drawn twice, which counting it in the raw writes cannot: Ink
 * redraws every frame, so the raw text repeats a line however many times it ends up on screen.
 */
export function terminalScreen(text: string): string[] {
  const rows: string[] = [""]
  let row = 0
  let col = 0
  const put = (char: string): void => {
    while (rows.length <= row) rows.push("")
    const line = (rows[row] ?? "").padEnd(col, " ")
    rows[row] = line.slice(0, col) + char + line.slice(col + 1)
    col += 1
  }
  const csi = (params: string, final: string): void => {
    const n = Number.parseInt(params.replace(/^\?/, ""), 10)
    const count = Number.isNaN(n) ? 1 : n
    if (final === "A") row = Math.max(0, row - count)
    else if (final === "B") row += count
    else if (final === "G") col = Number.isNaN(n) ? 0 : n - 1
    else if (final === "K") rows[row] = ""
    else if (final === "H" || final === "f") {
      row = 0
      col = 0
    } else if (final === "J" && params === "2") rows.splice(0, rows.length, "")
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? ""
    if (char === "\u001B" && text[i + 1] === "[") {
      const match = /^\u001B\[([?0-9;]*)([A-Za-z])/.exec(text.slice(i))
      if (match) {
        csi(match[1] ?? "", match[2] ?? "")
        i += match[0].length - 1
        continue
      }
    }
    if (char === "\n") {
      row += 1
      col = 0
    } else if (char === "\r") col = 0
    else if (char >= " ") put(char)
  }
  return rows.map((line) => line.trimEnd())
}

/** How many of the screen's lines hold `needle`. */
export function linesHolding(screen: readonly string[], needle: string): number {
  return screen.filter((line) => line.includes(needle)).length
}
