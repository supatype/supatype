import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Which views claim to be showing project rows, and therefore raise the elevated-access notice.
 *
 * The notice was mounted once above every view, which made it a statement about Studio rather than
 * about what was on screen. It appeared over the Rules tab, API docs and settings, none of which
 * read a row that a policy could have filtered. A warning that is always on is one nobody reads by
 * the time it means something.
 *
 * So the claim is opt-in, and this pins who opts in. It fails in both directions on purpose: adding
 * the hook to a view that renders no records puts the warning back where it does not belong, and
 * dropping it from one that does leaves an admin unable to tell an empty table from a filtered one.
 */

const VIEWS_DIR = fileURLToPath(new URL("../src/views", import.meta.url))

/** Views that put project records on screen. Every one of these reads with the service role. */
const SHOWS_ROWS = [
  "AuthManagement",
  "Dashboard",
  "DataExplorer",
  "EditView",
  "GlobalEditView",
  "ListView",
  "MediaLibrary",
  "SqlRunner",
  "VersionHistory",
]

function viewsCallingTheHook(): string[] {
  return readdirSync(VIEWS_DIR)
    .filter((f) => f.endsWith(".tsx"))
    .filter((f) => readFileSync(join(VIEWS_DIR, f), "utf8").includes("useShowsProjectRows()"))
    .map((f) => f.replace(/\.tsx$/, ""))
    .sort()
}

describe("the elevated-access notice", () => {
  it("is claimed by exactly the views that show project rows", () => {
    expect(viewsCallingTheHook()).toEqual(SHOWS_ROWS)
  })

  it("is not claimed by views that only render schema, docs or settings", () => {
    // The ones the always-on banner was visibly wrong over.
    for (const view of ["ModelRules", "ModelSchema", "ModelApiDocs", "Settings", "MigrationHistory"]) {
      expect(viewsCallingTheHook(), `${view} reads no project rows`).not.toContain(view)
    }
  })

  it("gates the banner on the claim, not only on the role", () => {
    // Without the second condition the hook is decoration and the banner is global again.
    const source = readFileSync(
      fileURLToPath(new URL("../src/components/ElevatedModeBanner.tsx", import.meta.url)),
      "utf8",
    )
    expect(source).toContain('if (mode !== "elevated" || !active) return null')
  })
})
