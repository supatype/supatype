import { describe, expect, it } from "vitest"
import { explainRefusal } from "../src/lib/database-refusal.js"
import type { FieldConfig } from "../src/config.js"
import { testField } from "./support.js"

/**
 * A database refusal in an editor's words, on the field it is about.
 *
 * Saving a speaker showed `null value in column "slug" of relation "speaker" violates not-null
 * constraint` as it came. Every refusal a save can meet is now said plainly, placed on its field
 * where the answer names one, and the server's own text kept behind a details toggle.
 */

const FIELDS: FieldConfig[] = [
  testField({ name: "name", label: "Name" }),
  testField({ name: "slug", label: "Slug", widget: "slug" }),
  testField({ name: "email", label: "Email" }),
  testField({ name: "rating", label: "Rating", widget: "number" }),
  testField({ name: "speaker", label: "Speaker", widget: "relation", options: { cardinality: "belongsTo", foreignKey: "speaker_id" } }),
  testField({ name: "starts_at", label: "Starts at", widget: "datetime" }),
]

function explain(error: { message: string; code?: string; details?: string; field?: string }, values: Record<string, unknown> = {}) {
  return explainRefusal(error, FIELDS, values)
}

describe("explainRefusal", () => {
  it("says a not-null refusal is a required field, on that field", () => {
    const out = explain({ code: "23502", message: 'null value in column "slug" of relation "speaker" violates not-null constraint' })
    expect(out).toMatchObject({ field: "slug", message: "is required", banner: "Slug is required" })
    expect(out.details).toContain('null value in column "slug"')
  })

  it("reads the kind from the wording when the code did not travel", () => {
    const out = explain({ message: 'null value in column "slug" of relation "speaker" violates not-null constraint' })
    expect(out).toMatchObject({ field: "slug", banner: "Slug is required" })
  })

  it("puts a unique refusal on the column its detail line names", () => {
    const out = explain({
      code: "23505",
      message: 'duplicate key value violates unique constraint "speaker_slug_key"',
      details: "Key (slug)=(ada) already exists.",
    })
    expect(out).toMatchObject({ field: "slug", message: "is already used by another record", banner: "Slug is already used by another record" })
  })

  it("puts a check refusal on the column its constraint is named for", () => {
    const out = explain({ code: "23514", message: 'new row for relation "speaker" violates check constraint "speaker_rating_check"' })
    expect(out).toMatchObject({ field: "rating", message: "is not an allowed value", banner: "Rating is not an allowed value" })
  })

  it("puts a missing foreign key on the relation that holds it", () => {
    const out = explain({
      code: "23503",
      message: 'insert or update on table "talk" violates foreign key constraint "talk_speaker_id_fkey"',
      details: 'Key (speaker_id)=(00000000-0000-0000-0000-000000000000) is not present in table "speaker".',
    })
    expect(out).toMatchObject({ field: "speaker", message: "points to a speaker that does not exist" })
  })

  it("says a record still in use cannot be removed", () => {
    const out = explain({
      code: "23503",
      message: 'update or delete on table "speaker" violates foreign key constraint "talk_speaker_id_fkey" on table "talk"',
      details: 'Key (id)=(abc) is still referenced from table "talk".',
    })
    expect(out).toMatchObject({ field: null, banner: "This record is still used by a talk, so it cannot be removed or changed." })
  })

  it("puts invalid input on the field holding the value", () => {
    const out = explain({ code: "22007", message: 'invalid input syntax for type timestamp with time zone: "soon"' }, { starts_at: "soon" })
    expect(out).toMatchObject({ field: "starts_at", message: "is not a valid timestamp with time zone" })
  })

  it("says what invalid input it could not place", () => {
    const out = explain({ code: "22P02", message: 'invalid input syntax for type uuid: "abc"' })
    expect(out).toMatchObject({ field: null, banner: '"abc" is not a valid uuid.' })
  })

  it("puts a value that is too long on the one field that long", () => {
    const out = explain({ code: "22001", message: "value too long for type character varying(5)" }, { name: "Ada", email: "ada@example.com" })
    expect(out).toMatchObject({ field: "email", message: "must be 5 characters or fewer" })
  })

  it("says permission is missing without the database's words", () => {
    const out = explain({ code: "42501", message: "permission denied for table speaker" })
    expect(out).toMatchObject({ field: null, banner: "You do not have permission to make this change." })
    expect(out.details).toBe("permission denied for table speaker")
  })

  it("says a refusal from the Studio role is the Studio role's, with the server's words under details", () => {
    const out = explain({ message: 'Studio role "viewer" cannot perform this request' })
    expect(out).toMatchObject({ field: null, banner: "This change isn't allowed by your Studio role." })
    expect(out.details).toBe('Studio role "viewer" cannot perform this request')
  })

  it("says a row rule refused the change, not the policy's raw text", () => {
    const out = explain({ code: "42501", message: 'new row violates row-level security policy for table "speaker"' })
    expect(out).toMatchObject({ field: null, banner: "This change isn't allowed by the project's row rules." })
  })

  it("puts a column the caller may not change on its field, as its field rule", () => {
    const out = explain({ code: "42501", message: 'permission denied for column "email" of relation "speaker"' })
    expect(out).toMatchObject({ field: "email", message: "can't be changed: its field rule doesn't allow it" })
  })

  it("keeps a field validator's own words on its field", () => {
    const out = explain({ message: "must be a company address", field: "email" })
    expect(out).toEqual({ field: "email", message: "must be a company address", banner: "must be a company address", details: null })
  })

  it("falls back to a plain sentence with the server's text as details", () => {
    const out = explain({ code: "XX000", message: "could not serialize access due to concurrent update" })
    expect(out).toEqual({
      field: null,
      message: null,
      banner: "The database refused this change.",
      details: "could not serialize access due to concurrent update",
    })
  })
})
