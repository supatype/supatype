/**
 * Supatype ASCII wordmark for the dev TUI header.
 * Baked from `figlet -f slant supatype` → assets/supatype-logo-wordmark.ascii.txt
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { BOLD, RESET, taskColor } from "./dev-task-colors.js"

const EMBEDDED_LOGO_WORDMARK = [
  "                           __                 ",
  "   _______  ______  ____ _/ /___  ______  ___ ",
  "  / ___/ / / / __ \\/ __ `/ __/ / / / __ \\/ _ \\",
  " (__  ) /_/ / /_/ / /_/ / /_/ /_/ / /_/ /  __/",
  "/____/\\__,_/ .___/\\__,_/\\__/\\__, / .___/\\___/ ",
  "          /_/              /____/_/           ",
] as const

function readLogoFile(basename: string): readonly string[] | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, "assets", basename),
    join(here, "..", "assets", basename),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const lines = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
      .filter((line) => line.length > 0)
    if (lines.length > 0) return lines
  }
  return null
}

function loadWordmarkLogoLines(): readonly string[] {
  const fromFile = readLogoFile("supatype-logo-wordmark.ascii.txt")
  if (fromFile) return fromFile
  return [...EMBEDDED_LOGO_WORDMARK]
}

/** Figlet slant wordmark (~46×6). */
export const SUPATYPE_ASCII_LOGO_WORDMARK = loadWordmarkLogoLines()

export function pickLogoLines(): readonly string[] {
  return SUPATYPE_ASCII_LOGO_WORDMARK
}

export function logoRowCount(): number {
  return pickLogoLines().length
}

/** Return logo rows exactly as authored (spaces preserved). */
export function layoutLogoBlock(lines: readonly string[]): string[] {
  return [...lines]
}

export function colorLogoLines(lines: readonly string[]): string[] {
  const purple = taskColor("stack")
  return lines.map((line) => `${purple}${BOLD}${line}${RESET}`)
}
