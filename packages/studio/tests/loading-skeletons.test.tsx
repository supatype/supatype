import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { SettingsLoading } from "../src/views/auth/AuthSettingsTable.js"

/**
 * Every loading placeholder in Studio is drawn by the shared skeleton primitives in
 * `components/ui.tsx`: `LoadingRows` for a list, `Skeleton` for any other shape. A placeholder a
 * view draws for itself carries its own colour, radius and pulse, and drifts from the rest.
 */

const SRC = fileURLToPath(new URL("../src/", import.meta.url))
const SHARED = "components/ui.tsx"

/** Every .tsx file under `dir`, as a path relative to src. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return path.endsWith(".tsx") ? [relative(SRC, path).replace(/\\/g, "/")] : []
  })
}

describe("loading placeholders", () => {
  it("pulse only inside the shared skeleton primitives", () => {
    const drawnByHand = sources(SRC)
      .filter((file) => file !== SHARED)
      .filter((file) => readFileSync(join(SRC, file), "utf8").includes("animate-pulse"))
    expect(drawnByHand).toEqual([])
  })

  it("draw the auth settings placeholder as the shared LoadingRows", () => {
    const html = renderToStaticMarkup(<SettingsLoading />)
    expect(html).toContain('data-ui="loading-rows"')
    expect(html.match(/data-ui="skeleton"/g)).toHaveLength(3)
  })
})
