/**
 * A name Studio writes into SQL, quoted as Postgres reads a quoted identifier: wrapped in `"`, with
 * each `"` inside doubled. The name keeps its case and every character, so `MyApp` stays `MyApp`
 * instead of folding to `myapp`, and a quote in it cannot end the identifier early.
 */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** `schema.name`, each part quoted on its own. */
export function qualifiedName(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`
}
