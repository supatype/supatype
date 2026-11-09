/**
 * Pinned service URLs + dev keys for the Ink dashboard.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { detectPackageManager } from "./app/framework.js"
import { appendStackOutput, getActiveDevSession } from "./dev-session.js"
import { readEnvValue } from "./env-file.js"
import { redact } from "./error-message.js"
import { secretFingerprint } from "./local-secrets.js"

export interface DevServiceLink {
  label: string
  url: string
}

/**
 * What the panel shows, with nothing secret left in it: the service_role key only as a
 * fingerprint and where to read it, and no password. Built by {@link publishDevReady}.
 */
export interface DevReadyPanel {
  title: string
  links: DevServiceLink[]
  anonKey?: string
  serviceRoleKeyNote?: string
  hints?: string[]
}

/** What dev hands {@link publishDevReady}, secrets included; they are masked before anything prints. */
export interface DevReadyInput {
  cwd: string
  title: string
  links: DevServiceLink[]
  anonKey: string
  serviceRoleKey: string
  /** The database's connection string, printed with its password masked. */
  databaseUrl?: string
  hints?: string[]
}

/** Ink row budget for DevReadyPanelView (border, title, links, hints, keys, margin). */
export function devReadyPanelRowCount(panel: DevReadyPanel): number {
  let rows = 2 // round border top + bottom
  rows += 1 // title
  rows += panel.links.length
  for (const hint of panel.hints ?? []) {
    if (hint.trim()) rows += 1
  }
  if (panel.anonKey) {
    rows += 1 // "API keys (local dev)"
    rows += 1 // anon
    if (panel.serviceRoleKeyNote) rows += 1 // service_role
  }
  rows += 1 // marginBottom on panel box
  return rows
}

/** Shorter panel when the terminal is too small for every service row. */
export function devReadyPanelCompactRowCount(panel: DevReadyPanel): number {
  let rows = 2 // border
  rows += 1 // title
  rows += 2 // gateway + studio summary
  for (const hint of panel.hints ?? []) {
    if (hint.trim()) rows += 1
  }
  if (panel.anonKey) {
    rows += 1
    rows += 1
    if (panel.serviceRoleKeyNote) rows += 1
  }
  rows += 1 // marginBottom
  return rows
}

function formatStreamBlock(panel: DevReadyPanel): string {
  const lines = [`[supatype] ${panel.title}`]
  for (const link of panel.links) {
    lines.push(`  ${link.label.padEnd(16)} ${link.url}`)
  }
  for (const hint of panel.hints ?? []) {
    lines.push(`  ${hint}`)
  }
  if (panel.anonKey) {
    lines.push("  API keys (local dev only):")
    lines.push(`    anon key       ${panel.anonKey}`)
    lines.push(`    service_role   ${panel.serviceRoleKeyNote ?? ""}`)
  }
  lines.push("  Press Ctrl+C to stop.")
  return lines.join("\n")
}

/**
 * The service_role key as the panel shows it: a fingerprint and where the key is. Printed whole,
 * it landed in every CI log that ran `dev` (0.9.1 release test, S37). Docker dev writes the key to
 * `.env`, and native dev fills a blank SERVICE_ROLE_KEY there, so it is normally in `.env`. Native
 * dev leaves a value the user set alone, even one the stack cannot verify and so does not use;
 * the key in use is then only in the file native dev hands the functions worker.
 */
export function serviceRoleKeyNote(cwd: string, serviceRoleKey: string): string {
  const where = readEnvValue(cwd, "SERVICE_ROLE_KEY", "") === serviceRoleKey
    ? "SERVICE_ROLE_KEY in .env"
    : "in .supatype/service-role-key while dev runs"
  return `#${secretFingerprint(serviceRoleKey)} (${where})`
}

/**
 * The panel `input` describes, with its secrets masked. The Postgres line hides its password as
 * `status` does (issue 80); native dev printed it whole (0.9.1 release test, FF17).
 */
function readyPanel(input: DevReadyInput): DevReadyPanel {
  const database = input.databaseUrl === undefined ? [] : [`Postgres ${redact(input.databaseUrl)}`]
  const hints = [...database, ...(input.hints ?? [])]
  return {
    title: input.title,
    links: input.links,
    anonKey: input.anonKey,
    serviceRoleKeyNote: serviceRoleKeyNote(input.cwd, input.serviceRoleKey),
    ...(hints.length > 0 && { hints }),
  }
}

/** Pin links in the TUI or print the classic block in stream mode, secrets masked in both. */
export function publishDevReady(input: DevReadyInput): void {
  const panel = readyPanel(input)
  const session = getActiveDevSession()
  if (session?.isTui()) {
    session.bus.setReadyPanel(panel)
    appendStackOutput("Services running.", "log")
    return
  }
  console.log(formatStreamBlock(panel))
}

/**
 * The ready panel's demo data line, in the project's own package manager. It said `pnpm seed`
 * whatever the project used, which in an npm project is a command that does not exist.
 */
export function demoDataHint(cwd: string): string | undefined {
  if (!existsSync(join(cwd, "seed.ts"))) return undefined
  const pm = detectPackageManager(cwd)
  return `Demo data: ${pm === "npm" ? "npm run seed" : `${pm} seed`}`
}
