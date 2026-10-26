import type { FieldConfig } from "../config.js"
import { formatDurationValue } from "./duration.js"
import { formatGeoPoint, geoPointOf } from "./geo-point.js"
import { widgetFor } from "./widget-input.js"

/**
 * A stored value as a person reads it, for a field whose column does not hold readable text: a
 * duration's `{ ms }` as `1h 30m`, a point's hex EWKB as `51.5072° N, 0.1276° W`.
 *
 * The same formatters the edit widgets show, so a list cell and the form never disagree. Null for
 * every other field, and for a value of the wrong shape, so the caller falls back to its own text.
 */
export function formatFieldValue(field: FieldConfig, value: unknown): string | null {
  switch (widgetFor(field, value)) {
    case "duration":
      return formatDurationValue(value)
    case "geopoint": {
      const point = geoPointOf(value)
      return point === null ? null : formatGeoPoint(point)
    }
    default:
      return null
  }
}
