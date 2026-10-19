/**
 * A `GeoPoint` field: a `geography(Point, 4326)` column.
 *
 * PostgREST sends the column as hex EWKB, and takes a write as EWKT (`SRID=4326;POINT(lng lat)`) or
 * hex. It refuses GeoJSON text, and it silently wraps an out-of-range coordinate round the globe
 * (latitude 95 is stored as 85), so the range is checked here, before the write, not by the
 * database. Longitude comes first in both encodings, which is the swap this module exists to hide.
 */

import { isJsonObject } from "./json.js"

export interface LatLng {
  lat: number
  lng: number
}

/** The two coordinate boxes' text, as the widget hands it to the form when it is not a point yet. */
export interface LatLngDraft {
  lat: string
  lng: string
}

export type CheckedPoint = { ok: true; point: LatLng | null } | { ok: false; message: string }

const WGS84 = 4326
const POINT_TYPE = 1
const SRID_FLAG = 0x20000000
const HEX = /^(?:[0-9a-f]{2})+$/i
const NUMBER = "[-+]?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?"
const EWKT_POINT = new RegExp(`^(?:srid\\s*=\\s*(\\d+)\\s*;\\s*)?point\\s*\\(\\s*(${NUMBER})\\s+(${NUMBER})\\s*\\)$`, "i")
/** What an editor may type in a coordinate box: a decimal, not hex, not `Infinity`. */
const TYPED_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i

/** Hex digits in a 2D point: 21 bytes, or 25 with an SRID. */
const POINT_HEX_LENGTHS = [42, 50]

function hexBytes(hex: string): DataView | null {
  if (!POINT_HEX_LENGTHS.includes(hex.length) || !HEX.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return new DataView(bytes.buffer)
}

/** Where the coordinates start and which byte order they are in, for a 2D point in WGS 84. */
function pointHeader(view: DataView): { little: boolean; offset: number } | null {
  if (view.byteLength < 5) return null
  const order = view.getUint8(0)
  if (order !== 0 && order !== 1) return null
  const little = order === 1
  const type = view.getUint32(1, little)
  const hasSrid = (type & SRID_FLAG) !== 0
  // Anything left once the SRID flag is cleared (a Z or M flag, another geometry) is not a 2D point.
  if ((type & ~SRID_FLAG) >>> 0 !== POINT_TYPE) return null
  if (!hasSrid) return { little, offset: 5 }
  if (view.byteLength < 9 || view.getUint32(5, little) !== WGS84) return null
  return { little, offset: 9 }
}

/** A hex EWKB or WKB point, either byte order, with or without an SRID; null for anything else. */
export function decodeEwkbPoint(hex: string): LatLng | null {
  const view = hexBytes(hex)
  if (view === null) return null
  const header = pointHeader(view)
  if (header === null || view.byteLength !== header.offset + 16) return null
  const lng = view.getFloat64(header.offset, header.little)
  const lat = view.getFloat64(header.offset + 8, header.little)
  // `POINT EMPTY` is stored as two NaNs.
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null
}

function parseEwktPoint(text: string): LatLng | null {
  const match = EWKT_POINT.exec(text.trim())
  if (match === null) return null
  const [, srid, lng, lat] = match
  if (srid !== undefined && Number(srid) !== WGS84) return null
  return { lat: Number(lat), lng: Number(lng) }
}

/** The point a column value holds, read from hex EWKB or from EWKT; null when it holds none. */
export function geoPointOf(value: unknown): LatLng | null {
  if (typeof value !== "string") return null
  return decodeEwkbPoint(value) ?? parseEwktPoint(value)
}

export function isLatLngDraft(value: unknown): value is LatLngDraft {
  return isJsonObject(value) && typeof value["lat"] === "string" && typeof value["lng"] === "string"
}

/** Whether a point is inside the range PostGIS would otherwise wrap it into. */
export function inRange(point: LatLng): boolean {
  return Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180
}

/** The point as the EWKT PostGIS takes: longitude first. */
export function toEwkt(point: LatLng): string {
  return `SRID=${WGS84};POINT(${point.lng} ${point.lat})`
}

function readCoordinate(text: string, name: string, limit: number): number | string {
  const value = Number(text)
  if (!TYPED_NUMBER.test(text) || !Number.isFinite(value)) return `${name} must be a number`
  return Math.abs(value) <= limit ? value : `${name} must be between -${limit} and ${limit}`
}

/** The two boxes an editor fills in, as a point, as no point (both blank), or as why not. */
export function checkLatLng(latText: string, lngText: string): CheckedPoint {
  const latRaw = latText.trim()
  const lngRaw = lngText.trim()
  if (latRaw === "" && lngRaw === "") return { ok: true, point: null }
  if (lngRaw === "") return { ok: false, message: "Enter a longitude too, or clear both" }
  if (latRaw === "") return { ok: false, message: "Enter a latitude too, or clear both" }
  const lat = readCoordinate(latRaw, "Latitude", 90)
  if (typeof lat === "string") return { ok: false, message: lat }
  const lng = readCoordinate(lngRaw, "Longitude", 180)
  if (typeof lng === "string") return { ok: false, message: lng }
  return { ok: true, point: { lat, lng } }
}

function degrees(value: number, positive: string, negative: string): string {
  return `${Number(Math.abs(value).toFixed(6))}° ${value < 0 ? negative : positive}`
}

/** `51.5072° N, 0.1276° W`: hemispheres named, so the two numbers cannot be read the wrong way round. */
export function formatGeoPoint(point: LatLng): string {
  return `${degrees(point.lat, "N", "S")}, ${degrees(point.lng, "E", "W")}`
}
