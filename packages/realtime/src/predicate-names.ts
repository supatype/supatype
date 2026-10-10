/**
 * The names the schema engine gives its generated predicates, so realtime can find them in
 * `pg_proc` without a label pointing at them.
 *
 * A port of the engine's `make_object_name` (`managed.rs`), itself Postgres's `makeObjectName`:
 * `name1_name2_label`, fitted to the 63-byte identifier limit by taking a byte at a time from the
 * longer of `name1` and `name2` (`name2` on a tie), each then cut back to a character boundary.
 */

const MAX_IDENTIFIER_BYTES = 63

/** The longest prefix of `value` that fits in `limit` bytes without splitting a character. */
function clip(value: string, limit: number): string {
  const bytes = Buffer.from(value, "utf8")
  if (bytes.length <= limit) return value
  let cut = limit
  // A UTF-8 continuation byte is 10xxxxxx; back off until the cut is on a lead byte.
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut--
  return bytes.subarray(0, cut).toString("utf8")
}

export function makeObjectName(name1: string, name2: string | null, label: string): string {
  const overhead = (name2 === null ? 0 : 1) + (label === "" ? 0 : Buffer.byteLength(label, "utf8") + 1)
  const available = Math.max(MAX_IDENTIFIER_BYTES - overhead, 0)
  let name1Bytes = Buffer.byteLength(name1, "utf8")
  let name2Bytes = name2 === null ? 0 : Buffer.byteLength(name2, "utf8")
  while (name1Bytes + name2Bytes > available) {
    if (name1Bytes > name2Bytes) name1Bytes--
    else name2Bytes--
  }
  let out = clip(name1, name1Bytes)
  if (name2 !== null) out += `_${clip(name2, name2Bytes)}`
  if (label !== "") out += `_${label}`
  return out
}

/** `can_read_<table>`, the row predicate. */
export function rowReadPredicateName(table: string): string {
  return makeObjectName("can_read", table, "")
}

/**
 * `can_read_<table>__<column>`, a column's read predicate, as the engine names it when no other
 * field predicate of the table has already taken that name. Two columns long enough to clip to the
 * same name get a numbered variant instead, which this does not reproduce: the caller treats a
 * predicate it cannot attribute to exactly one column as a reason to stop, not to guess.
 */
export function fieldReadPredicateName(table: string, column: string): string {
  return makeObjectName(`can_read_${table}_`, column, "")
}
