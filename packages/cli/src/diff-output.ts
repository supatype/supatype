import type { DiffResult } from "./engine-client.js"

/** Print engine diff warnings before the operation list. */
export function printDiffWarnings(diff: DiffResult): void {
  const warnings = diff.warnings ?? []
  if (warnings.length === 0) return
  console.log(`\n${warnings.length} warning(s):\n`)
  for (const w of warnings) {
    console.log(`  [!] ${w}`)
  }
  console.log()
}
