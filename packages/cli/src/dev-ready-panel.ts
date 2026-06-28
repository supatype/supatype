/**
 * Pinned service URLs + dev keys for the Ink dashboard.
 */

import { appendStackOutput, getActiveDevSession } from "./dev-session.js"

export interface DevServiceLink {
  label: string
  url: string
}

export interface DevReadyPanel {
  title: string
  links: DevServiceLink[]
  anonKey?: string
  serviceRoleKey?: string
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
    if (panel.serviceRoleKey) rows += 1 // service_role
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
    if (panel.serviceRoleKey) rows += 1
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
    lines.push(`    service_role   ${panel.serviceRoleKey ?? ""}`)
  }
  lines.push("  Press Ctrl+C to stop.")
  return lines.join("\n")
}

/** Pin links in the TUI or print the classic block in stream mode. */
export function publishDevReady(panel: DevReadyPanel): void {
  const session = getActiveDevSession()
  if (session?.isTui()) {
    session.bus.setReadyPanel(panel)
    appendStackOutput("Services running.", "log")
    return
  }
  console.log(formatStreamBlock(panel))
}
