import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { EDITOR_NODES } from "../src/widgets/RichTextWidget.js"
import { buildLexicalDocuments } from "./fixtures/lexical-documents.js"

/**
 * The rich text renderers in @supatype/common are tested against fixtures of saved Lexical JSON.
 * This keeps those fixtures honest: it rebuilds every document with the Lexical version and node
 * set Studio's editor actually uses and fails when the committed JSON differs, so a Lexical upgrade
 * that changes what gets saved shows up here instead of as a blank paragraph on someone's site.
 *
 * Run with WRITE_LEXICAL_FIXTURES=1 to regenerate the file after an intended change.
 */

const FIXTURE_PATH = fileURLToPath(
  new URL("../../common/tests/fixtures/lexical-documents.json", import.meta.url),
)

describe("Lexical fixtures for the rich text renderers", () => {
  it("match what Studio's editor node set saves", () => {
    const built = buildLexicalDocuments(EDITOR_NODES)
    if (process.env["WRITE_LEXICAL_FIXTURES"] === "1") {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(built, null, 2)}\n`)
    }
    const committed: unknown = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"))
    expect(committed).toEqual(built)
  })
})
