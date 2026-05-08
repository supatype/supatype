/** Field names referenced in `{name}` / `{truncate(name, n)}` (must match extractor / engine resolver). */
export function fieldNamesInComputedTemplate(template: string): string[] {
  const fields = new Set<string>()
  let m: RegExpExecArray | null
  const reTrunc = /\{truncate\s*\(\s*([a-zA-Z_]\w*)\s*,\s*(\d+)\s*\)\}/gi
  while ((m = reTrunc.exec(template)) !== null) {
    const ref = m[1]
    if (ref) fields.add(ref)
  }
  const reSimple = /\{([a-zA-Z_]\w*)\}/g
  while ((m = reSimple.exec(template)) !== null) {
    const ref = m[1]
    if (ref) fields.add(ref)
  }
  return [...fields]
}

function truncatePreserveNewlines(raw: string, maxLen: number): string {
  if (maxLen <= 0 || raw.length <= maxLen) return raw
  return `${raw.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`
}

/**
 * Replaces `{field}` and `{truncate(field, n)}`; case-sensitive field names match the schema.
 * Applies `truncate(...)` fragments first so nothing inside `{truncate(...)}` is reinterpreted as a plain `{field}`.
 *
 * When `requireAtLeastOneReferencedField` is true (default) and the template names at least one field,
 * returns `""` until **any** referenced field is non-blank (trimmed). Plain-text templates with no `{…}` refs
 * are unchanged. Set `false` only if you need literal output with empty holes.
 */
export function applyComputedTemplate(
  template: string,
  getFieldText: (field: string) => string,
  options: { requireAtLeastOneReferencedField?: boolean } = {},
): string {
  const { requireAtLeastOneReferencedField = true } = options
  const refs = fieldNamesInComputedTemplate(template)
  if (requireAtLeastOneReferencedField && refs.length > 0) {
    const anyNonBlank = refs.some((field) => getFieldText(field).trim().length > 0)
    if (!anyNonBlank) return ""
  }
  let out = template.replace(
    /\{truncate\s*\(\s*([a-zA-Z_]\w*)\s*,\s*(\d+)\s*\)\}/gi,
    (_match, field: string, nStr: string) =>
      truncatePreserveNewlines(getFieldText(field), Number.parseInt(nStr, 10)),
  )
  out = out.replace(/\{([a-zA-Z_]\w*)\}/g, (_match, field: string) => getFieldText(field))
  return out
}
