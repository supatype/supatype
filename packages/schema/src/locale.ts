export interface LocaleDefinition {
  /** @internal */
  readonly __localeMeta: {
    locales: string[]
    defaultLocale: string
  }
}

/**
 * Declare the locales your project supports. Export this from your schema entry
 * point and the CLI will include it in the AST sent to the engine.
 *
 * @example
 * ```ts
 * export const localeConfig = locale({
 *   locales: ["en", "fr", "de"],
 *   defaultLocale: "en",
 * })
 * ```
 */
export function locale(config: {
  locales: string[]
  defaultLocale: string
}): LocaleDefinition {
  return { __localeMeta: config }
}
