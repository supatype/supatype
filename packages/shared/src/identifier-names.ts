/**
 * Names as Postgres keeps them, cut exactly as the schema engine cuts them.
 *
 * Postgres keeps only the first 63 bytes of an identifier, cut back to a character boundary. The
 * engine gives every table, versions table, junction, junction key column and column the name
 * Postgres keeps, so anything that names one of those (generated types, the hooks and cache
 * manifests, realtime's predicate lookup) has to cut the same way or it names a table that does
 * not exist. A port of the engine's `clip`, `clip_identifier` and `make_object_name`, itself
 * Postgres's `makeObjectName`.
 */

/** The bytes Postgres keeps of an identifier (`NAMEDATALEN - 1`). */
export const MAX_IDENTIFIER_BYTES = 63

/** The bytes one code point takes in UTF-8. A lone surrogate is written as U+FFFD, three bytes. */
function utf8Width(codePoint: number): number {
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  return codePoint < 0x10000 ? 3 : 4
}

/** The bytes `value` takes in UTF-8. */
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (const char of value) bytes += utf8Width(char.codePointAt(0) ?? 0)
  return bytes
}

/** The longest prefix of `value` that fits in `limit` bytes without splitting a character. */
export function clip(value: string, limit: number): string {
  let bytes = 0
  let out = ""
  for (const char of value) {
    bytes += utf8Width(char.codePointAt(0) ?? 0)
    if (bytes > limit) return out
    out += char
  }
  return out
}

/** `name` as Postgres stores it: anything past 63 bytes cut off, on a character boundary. */
export function keptName(name: string): string {
  return clip(name, MAX_IDENTIFIER_BYTES)
}

/**
 * `name1_name2_label`, fitted to 63 bytes by taking a byte at a time from the longer of `name1`
 * and `name2` (`name2` on a tie), each then cut back to a character boundary.
 */
export function makeObjectName(name1: string, name2: string | null, label: string): string {
  const overhead = (name2 === null ? 0 : 1) + (label === "" ? 0 : utf8ByteLength(label) + 1)
  const available = Math.max(MAX_IDENTIFIER_BYTES - overhead, 0)
  let name1Bytes = utf8ByteLength(name1)
  let name2Bytes = name2 === null ? 0 : utf8ByteLength(name2)
  while (name1Bytes + name2Bytes > available) {
    if (name1Bytes > name2Bytes) name1Bytes--
    else name2Bytes--
  }
  let out = clip(name1, name1Bytes)
  if (name2 !== null) out += `_${clip(name2, name2Bytes)}`
  if (label !== "") out += `_${label}`
  return out
}

/** A versioned table's snapshot table, named from the table as Postgres keeps it. */
export function versionsTableName(table: string): string {
  return makeObjectName(keptName(table), null, "versions")
}
