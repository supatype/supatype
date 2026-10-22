import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { PublishPanel, type PanelActions } from "../src/components/PublishBar.js"
import { DROP_LOOK } from "../src/components/database/DropPolicyButton.js"
import { describePanel } from "../src/lib/publish-panel.js"
import { WHOLE_RECORD } from "../src/lib/publishing.js"

/**
 * Red text across Studio (save errors, Drop links, the sign-in refusal) was written in
 * `--destructive`, a fill red at about 1.9:1 on the dark page. Text now uses `--destructive-text`
 * (4.5:1 or better, see error-banner-contrast). `text-destructive-foreground` (white on a red fill)
 * and the fill and border classes are a different thing and stay.
 */

/** `text-destructive` used as a text colour, plain or behind a variant such as `hover:`. */
const FILL_RED_TEXT = /(?:^|[\s"'`:])text-destructive(?![-\w/])/

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".tsx") || path.endsWith(".ts") ? [path] : []
  })
}

const noActions: PanelActions = {
  publish: () => {}, schedule: () => {}, cancelSchedule: () => {}, discard: () => {}, unpublish: () => {},
  saveDraft: () => {}, viewChanges: () => {},
}

describe("red text", () => {
  it("a publish error renders in the readable token", () => {
    const panel = describePanel({ locales: [WHOLE_RECORD], state: null, dirty: false, creating: true, editing: null, labels: {} })
    const html = renderToStaticMarkup(
      <PublishPanel view={{ panel, title: "A post", locales: [], busy: false, saving: false, error: "Refused" }} actions={noActions} />,
    )
    expect(html).toMatch(/class="[^"]*text-destructive-text[^"]*" role="alert">Refused/)
  })

  it("a Drop link renders in the readable token", () => {
    expect(DROP_LOOK.className).toContain("text-destructive-text")
    expect(DROP_LOOK.className).not.toMatch(FILL_RED_TEXT)
  })

  it("is never the fill red anywhere in Studio's source", () => {
    const offenders = sourceFiles(join(process.cwd(), "src")).flatMap((file) =>
      readFileSync(file, "utf8").split("\n").flatMap((line, i) => (FILL_RED_TEXT.test(line) ? [`${file}:${String(i + 1)}`] : [])),
    )
    expect(offenders).toEqual([])
  })
})
