/**
 * What running processes say about themselves: their command line, and their parent, each read in
 * one call for every process asked about (PowerShell on Windows takes up to a second to start).
 */

import { runCaptured } from "./run-captured.js"
import { windowsProcessFields } from "./windows-processes.js"

/** A running process's command line and the id of the process that started it. */
export interface ProcessInfo {
  commandLine: string
  ppid: number
}

/** The ids worth asking about: positive whole numbers, once each. */
function askable(pids: readonly number[]): number[] {
  return [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0)
}

/** `ps` rows for each of `ids`: its numeric columns, then the command line exactly as printed. */
async function psColumns(ids: number[], columns: "pid=,args=" | "pid=,ppid=,args="): Promise<string[][]> {
  const run = await runCaptured("ps", ["-o", columns, ...ids.flatMap((pid) => ["-p", String(pid)])])
  const row = columns === "pid=,args=" ? /^\s*(\d+)\s+(.*\S)/ : /^\s*(\d+)\s+(\d+)\s+(.*\S)/
  return run.stdout.split("\n").flatMap((line) => {
    const match = row.exec(line)
    return match === null ? [] : [match.slice(1)]
  })
}

/** The command line of each of `pids` still running. One that has ended is left out. */
export async function commandLines(pids: readonly number[]): Promise<Map<number, string>> {
  const ids = askable(pids)
  if (ids.length === 0) return new Map()
  if (process.platform === "win32") return windowsProcessFields(ids, "CommandLine")
  return new Map((await psColumns(ids, "pid=,args=")).map(([pid, args]) => [Number(pid), args ?? ""]))
}

/** Each of `pids` still running, with its command line and parent. One that has ended is left out. */
export async function processInfo(pids: readonly number[]): Promise<Map<number, ProcessInfo>> {
  const ids = askable(pids)
  if (ids.length === 0) return new Map()
  if (process.platform === "win32") {
    const [lines, parents] = await Promise.all([commandLines(ids), windowsProcessFields(ids, "ParentProcessId")])
    return new Map([...lines].map(([pid, commandLine]) => [pid, { commandLine, ppid: Number(parents.get(pid) ?? 0) }]))
  }
  const rows = await psColumns(ids, "pid=,ppid=,args=")
  return new Map(rows.map(([pid, ppid, args]) => [Number(pid), { ppid: Number(ppid), commandLine: args ?? "" }]))
}
