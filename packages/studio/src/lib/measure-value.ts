import { isJsonObject } from "./json.js"

/**
 * How much of a value there is, in the same unit the column's `CHECK` counts.
 *
 * Shared by the bounds checker and the constraint evaluator. Two implementations of "how long is
 * this" would be two chances to disagree with the database, and the whole point of both is that they
 * do not.
 */
/** Plain text of a lexical document, mirroring `_supatype.richtext_text` in the database. */
function richTextLength(value: object): number | undefined {
  let total = 0
  let sawText = false
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (!isJsonObject(node)) return
    if (typeof node["text"] === "string") {
      total += node["text"].length
      sawText = true
    }
    walk(node["children"])
    walk(node["root"])
  }
  walk(value)
  return sawText || (isJsonObject(value) && value["root"] !== undefined) ? total : undefined
}

/**
 * How much of a value there is, in the same unit the column's `CHECK` counts.
 *
 * The unit is a property of the value, not of the bound: characters for text, plain-text characters
 * for a rich-text document. Getting this wrong is what produced a `char_length` applied to an array,
 * which is not merely incorrect but does not exist in Postgres.
 *
 * Collections are deliberately absent. `itemsMessage` counts them, and a `maxLength` that somehow
 * reaches an array must not quietly become an item count: that conflation is the thing the split
 * into MaxLength and MaxItems removed, and reintroducing it here would undo it in the one place
 * nobody would look.
 */
export function lengthOf(value: unknown): number | undefined {
  if (typeof value === "string") return value.length
  if (typeof value === "object" && value !== null) return richTextLength(value)
  return undefined
}

/**
 * How many elements a value holds, for an `ItemCount` operand or a `MaxItems` bound.
 *
 * Separate from {@link lengthOf} on purpose, and the reason is the same one that split `MaxLength`
 * from `MaxItems`: length is how much text, count is how many. `lengthOf` deliberately refuses an
 * array so a stale `maxLength` cannot quietly become an item count, which means the constraint
 * evaluator needs its own way to ask the other question.
 */
export function itemCountOf(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined
}
