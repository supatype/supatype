import type { SerializedEditorState } from "@supatype/types/lexical"
import type { TableRow } from "@supatype/client"

/**
 * One language of a post's body, as the saved editor state `RichText` renders. Null when that
 * language has nothing written.
 *
 * `body` is localized, so it arrives as the whole locale record and the page picks the language
 * rather than the API guessing at one. Handed the whole record, `RichText` renders nothing.
 */
export function postBodyIn(body: TableRow<"post">["body"] | null, locale: string): SerializedEditorState | null {
  return body?.[locale] ?? null
}
