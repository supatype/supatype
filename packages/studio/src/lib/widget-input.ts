import type { FieldConfig, WidgetType } from "../config.js"
import { durationMsOf } from "./duration.js"
import { checkLatLng, geoPointOf, inRange, isLatLngDraft } from "./geo-point.js"

/**
 * Input a widget could not turn into a value the column takes.
 *
 * A widget that reads text (`1h 30m`, two coordinate boxes) hands the form what was typed when it
 * cannot read it, rather than keeping the previous value, so that Save does not quietly store the old
 * value as if the edit had worked. This is where that typed input is refused.
 *
 * Unlike the declared bounds, these are not rules the database holds. A duration is JSONB and would
 * take any text, and PostGIS wraps an out-of-range coordinate rather than refusing it.
 */

const DURATION_HINT = "must be a duration such as 1h 30m, 90m or 1:30:00"
const POINT_HINT = "must be a point with latitude between -90 and 90 and longitude between -180 and 180"

function durationMessage(value: unknown): string | null {
  return durationMsOf(value) === null ? DURATION_HINT : null
}

function pointMessage(value: unknown): string | null {
  const point = geoPointOf(value)
  if (point !== null) return inRange(point) ? null : POINT_HINT
  if (!isLatLngDraft(value)) return POINT_HINT
  const checked = checkLatLng(value.lat, value.lng)
  return checked.ok ? null : `needs a valid point: ${checked.message.toLowerCase()}`
}

/**
 * The widget a field is edited and shown with, given its value.
 *
 * An engine from before the `geopoint` widget names a point column `text`, and its admin config
 * carries no column kind to tell it apart. The value can: hex EWKB that decodes as a point, the EWKT
 * the point widget writes, or the boxes it hands over mid-edit. A text column holding exactly that is
 * a point column. A point column with no value yet still shows as text on such an engine, which is
 * no worse than before.
 */
export function widgetFor(field: FieldConfig, value: unknown): WidgetType {
  if (field.widget !== "text") return field.widget
  return geoPointOf(value) !== null || isLatLngDraft(value) ? "geopoint" : "text"
}

/** Why a field's value is input its widget could not read, or null when it is a value (or empty). */
export function widgetInputMessage(field: FieldConfig, value: unknown): string | null {
  if (value === null || value === undefined) return null
  switch (widgetFor(field, value)) {
    case "duration":
      return durationMessage(value)
    case "geopoint":
      return pointMessage(value)
    default:
      return null
  }
}
