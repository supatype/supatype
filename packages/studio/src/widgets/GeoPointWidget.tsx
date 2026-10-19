import React from "react"
import type { WidgetProps } from "./FieldWidget.js"
import { Input } from "../components/ui.js"
import {
  checkLatLng,
  formatGeoPoint,
  geoPointOf,
  isLatLngDraft,
  toEwkt,
  type CheckedPoint,
  type LatLng,
  type LatLngDraft,
} from "../lib/geo-point.js"
import { useFieldDraft } from "./use-field-draft.js"

/**
 * Editor for a `GeoPoint` field (`geography(Point, 4326)`): a latitude box and a longitude box,
 * each range-checked, because PostGIS would otherwise wrap an out-of-range value round the globe
 * and store a different place without a word. The column's hex EWKB is decoded for display and the
 * edit is written as EWKT; both boxes blank is no point, which clears an optional field.
 *
 * Boxes that do not make a point yet (one blank, or out of range) are handed to the form as typed,
 * `{ lat, lng }` strings, so the save check refuses them rather than the old point being kept.
 */

function draftOf(value: unknown): LatLngDraft {
  const point = geoPointOf(value)
  if (point !== null) return { lat: String(point.lat), lng: String(point.lng) }
  return isLatLngDraft(value) ? { lat: value.lat, lng: value.lng } : { lat: "", lng: "" }
}

function valueOf(draft: LatLngDraft): unknown {
  const checked = checkLatLng(draft.lat, draft.lng)
  if (!checked.ok) return { ...draft }
  return checked.point === null ? null : toEwkt(checked.point)
}

export interface GeoPointDraft {
  draft: LatLngDraft
  checked: CheckedPoint
  setLat: (lat: string) => void
  setLng: (lng: string) => void
  setPoint: (point: LatLng) => void
}

/**
 * The boxes' state, and the one way to set a whole point at once.
 *
 * `setPoint` is the hook for a map picker: a map that calls it with the clicked place fills both
 * boxes and the form value together, so it needs no storage or validation of its own.
 */
export function useGeoPointDraft(value: unknown, onChange: (value: unknown) => void): GeoPointDraft {
  const { draft, update } = useFieldDraft(value, onChange, draftOf)
  const set = (next: LatLngDraft): void => update(next, valueOf(next))
  return {
    draft,
    checked: checkLatLng(draft.lat, draft.lng),
    setLat: (lat: string) => set({ ...draft, lat }),
    setLng: (lng: string) => set({ ...draft, lng }),
    setPoint: (point: LatLng) => set({ lat: String(point.lat), lng: String(point.lng) }),
  }
}

/** What both boxes share: whether the pair is refused, and what explains it. */
interface CoordinateState {
  invalid: boolean
  describedBy: string | undefined
  readOnly: boolean
  required: boolean
}

interface CoordinateProps {
  box: { id: string; label: string; value: string }
  state: CoordinateState
  onChange: (text: string) => void
}

function Coordinate({ box, state, onChange }: CoordinateProps): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col gap-1">
      <label className="text-xs text-muted-foreground" htmlFor={box.id}>{box.label}</label>
      <Input
        id={box.id}
        value={box.value}
        inputMode="decimal"
        readOnly={state.readOnly}
        required={state.required}
        aria-invalid={state.invalid}
        {...(state.describedBy !== undefined && { "aria-describedby": state.describedBy })}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

export function GeoPointWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const { draft, checked, setLat, setLng } = useGeoPointDraft(value, onChange)
  const messageId = `field-${config.name}-geopoint-error`
  const state = { invalid: !checked.ok, describedBy: checked.ok ? undefined : messageId, readOnly, required: config.required }

  return (
    <div className="st-geopoint-widget flex flex-col gap-1">
      <div className="flex gap-2">
        <Coordinate box={{ id: `field-${config.name}`, label: "Latitude", value: draft.lat }} state={state} onChange={setLat} />
        <Coordinate box={{ id: `field-${config.name}-lng`, label: "Longitude", value: draft.lng }} state={state} onChange={setLng} />
      </div>
      {!checked.ok && <p className="st-field-error" id={messageId} role="alert">{checked.message}</p>}
      {checked.ok && checked.point !== null && (
        <p className="st-field-hint text-xs text-muted-foreground">{formatGeoPoint(checked.point)}</p>
      )}
    </div>
  )
}
