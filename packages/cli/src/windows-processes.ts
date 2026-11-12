import { runCaptured } from "./run-captured.js"

/**
 * How long a process lookup may take. PowerShell can take seconds to start on a busy machine, and a
 * lookup that never ends must not hold whatever is waiting on it.
 */
const LOOKUP_TIMEOUT_MS = 15_000

/**
 * One `Win32_Process` field of each of `pids` that is still running, read in a single PowerShell
 * call: PowerShell takes up to a second to start, so a call per process added up. A process that
 * has ended, or whose field is empty, is left out, as is every process when the lookup fails.
 */
export async function windowsProcessFields(
  pids: readonly number[],
  field: "CommandLine" | "ParentProcessId",
): Promise<Map<number, string>> {
  const ids = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0)
  const values = new Map<number, string>()
  if (ids.length === 0) return values
  const filter = ids.map((pid) => `ProcessId=${pid}`).join(" OR ")
  const query = `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { [string]$_.ProcessId + [char]9 + $_.${field} }`
  const run = await runCaptured("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query], {
    timeout: LOOKUP_TIMEOUT_MS,
  })
  for (const line of run.stdout.split(/\r?\n/)) {
    const tab = line.indexOf("\t")
    const pid = Number(line.slice(0, tab))
    const value = line.slice(tab + 1).trim()
    if (tab > 0 && Number.isInteger(pid) && value !== "") values.set(pid, value)
  }
  return values
}
