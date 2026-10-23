import { describe, expect, it } from "vitest"
import { keptName, makeObjectName, utf8ByteLength, versionsTableName } from "../src/index.js"

// Vectors taken from the schema engine's own tests (`tests/long_table_names_tests.rs` and the
// `make_object_name` cases in `src/managed.rs`), so the two cutters are checked against one source.
const LONG_TABLE = "conference_attendee_registration_dietary_preferences_and_requirements"
const LEFT = "conference_attendee_registration_dietary_notes"
const RIGHT = "conference_session_speaker_availability_window"

describe("keptName()", () => {
  it("keeps a name of 63 bytes or fewer as it is", () => {
    expect(keptName("posts")).toBe("posts")
    expect(keptName("a".repeat(63))).toBe("a".repeat(63))
  })

  it("cuts a 64-byte name to its first 63 bytes", () => {
    expect(keptName("a".repeat(64))).toBe("a".repeat(63))
    expect(keptName(LONG_TABLE)).toBe(LONG_TABLE.slice(0, 63))
  })

  it("cuts a joined junction name as the engine does", () => {
    expect(keptName(`${LEFT}_${RIGHT}`)).toBe(`${LEFT}_${RIGHT}`.slice(0, 63))
  })

  it("cuts a junction key column named from a long model", () => {
    expect(keptName(`${LONG_TABLE}_id`)).toBe(`${LONG_TABLE}_id`.slice(0, 63))
  })

  it("cuts a multibyte name on a character boundary", () => {
    expect(keptName("é".repeat(40))).toBe("é".repeat(31))
    expect(utf8ByteLength(keptName("é".repeat(40)))).toBe(62)
  })

  it("never splits a four-byte character", () => {
    const name = keptName(`${"a".repeat(61)}\u{1f600}`)
    expect(name).toBe("a".repeat(61))
  })
})

describe("makeObjectName() and versionsTableName()", () => {
  it("names a long table's versions table from its first 54 bytes", () => {
    expect(versionsTableName(LONG_TABLE)).toBe(`${LONG_TABLE.slice(0, 54)}_versions`)
    expect(versionsTableName("posts")).toBe("posts_versions")
  })

  it("names a long table's primary key from its first 58 bytes", () => {
    const base = "t".repeat(70)
    expect(makeObjectName(base, null, "pkey")).toBe(`${"t".repeat(58)}_pkey`)
  })

  it("takes bytes from the longer name first, name2 on a tie", () => {
    expect(makeObjectName("a".repeat(40), "b".repeat(40), "fkey")).toBe(`${"a".repeat(29)}_${"b".repeat(28)}_fkey`)
  })
})
