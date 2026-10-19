import { describe, expect, it } from "vitest"
import {
  checkLatLng,
  decodeEwkbPoint,
  formatGeoPoint,
  geoPointOf,
  toEwkt,
} from "../src/lib/geo-point.js"

/**
 * A `geography(Point, 4326)` column reaches Studio as hex EWKB and is written as EWKT. Every hex
 * string below is real PostGIS output, from SELECTs run against the kitchen-sink database:
 *
 *   ST_GeogFromText('SRID=4326;POINT(-0.1276 51.5072)')::text                       -- LE_SRID
 *   encode(ST_AsBinary(ST_GeomFromText('POINT(-0.1276 51.5072)')), 'hex')           -- LE_PLAIN
 *   encode(ST_AsEWKB(ST_GeomFromText('POINT(-0.1276 51.5072)', 4326), 'XDR'), 'hex') -- BE_SRID
 *   encode(ST_AsBinary(ST_GeomFromText('POINT(-0.1276 51.5072)'), 'XDR'), 'hex')    -- BE_PLAIN
 */

const LONDON = { lat: 51.5072, lng: -0.1276 }
const LE_SRID = "0101000020E6100000DA1B7C613255C0BFFE43FAEDEBC04940"
const LE_PLAIN = "0101000000da1b7c613255c0bffe43faedebc04940"
const BE_SRID = "0020000001000010e6bfc05532617c1bda4049c0ebedfa43fe"
const BE_PLAIN = "0000000001bfc05532617c1bda4049c0ebedfa43fe"
const SYDNEY = "0101000020E6100000B1E1E995B2E66240E561A1D634EF40C0"
const ORIGIN = "0101000020E610000000000000000000000000000000000000"
const SOUTH_WEST_CORNER = "0101000020E610000000000000008066C000000000008056C0"
const NORTH_EAST_CORNER = "0101000020E610000000000000008066400000000000805640"
const POLYGON =
  "0103000020E6100000010000000400000000000000000000000000000000000000000000000000F03F0000000000000000000000000000F03F000000000000F03F00000000000000000000000000000000"
const POINT_Z = "01010000A0E6100000000000000000F03F00000000000000400000000000000840"
const POINT_EMPTY = "0101000020E6100000000000000000F87F000000000000F87F"

describe("decodeEwkbPoint", () => {
  it.each([
    ["little endian with SRID", LE_SRID],
    ["little endian without SRID", LE_PLAIN],
    ["big endian with SRID", BE_SRID],
    ["big endian without SRID", BE_PLAIN],
  ])("reads %s", (_, hex) => {
    expect(decodeEwkbPoint(hex)).toEqual(LONDON)
  })

  it("reads the southern and eastern hemispheres", () => {
    expect(decodeEwkbPoint(SYDNEY)).toEqual({ lat: -33.8688, lng: 151.2093 })
  })

  it("reads the origin and both corners of the range", () => {
    expect(decodeEwkbPoint(ORIGIN)).toEqual({ lat: 0, lng: 0 })
    expect(decodeEwkbPoint(SOUTH_WEST_CORNER)).toEqual({ lat: -90, lng: -180 })
    expect(decodeEwkbPoint(NORTH_EAST_CORNER)).toEqual({ lat: 90, lng: 180 })
  })

  it.each([
    ["a polygon", POLYGON],
    ["a point with a Z coordinate", POINT_Z],
    ["an empty point", POINT_EMPTY],
    ["a truncated point", LE_SRID.slice(0, 40)],
    ["a point with trailing bytes", `${LE_SRID}00`],
    ["an odd number of digits", LE_SRID.slice(1)],
    ["text that is not hex", "SRID=4326;POINT(-0.1276 51.5072)"],
    ["a byte-order marker that is neither 0 nor 1", `02${LE_SRID.slice(2)}`],
    ["an empty string", ""],
    ["a point in another SRID", LE_SRID.replace("E6100000", "110F0000")],
  ])("refuses %s", (_, hex) => {
    expect(decodeEwkbPoint(hex)).toBeNull()
  })
})

describe("geoPointOf", () => {
  it("reads hex EWKB and the EWKT Studio writes", () => {
    expect(geoPointOf(LE_SRID)).toEqual(LONDON)
    expect(geoPointOf("SRID=4326;POINT(-0.1276 51.5072)")).toEqual(LONDON)
    expect(geoPointOf("POINT(-0.1276 51.5072)")).toEqual(LONDON)
    expect(geoPointOf("srid=4326; point ( 151.2093  -33.8688 )")).toEqual({ lat: -33.8688, lng: 151.2093 })
  })

  it.each([[null], [undefined], [42], [{ lat: 1, lng: 2 }], ["SRID=3857;POINT(1 2)"], ["POINT(1)"], ["POINT(a b)"], [POLYGON]])(
    "has no point in %j",
    (value) => {
      expect(geoPointOf(value)).toBeNull()
    },
  )
})

describe("toEwkt", () => {
  it("writes longitude first, as PostGIS reads it", () => {
    expect(toEwkt(LONDON)).toBe("SRID=4326;POINT(-0.1276 51.5072)")
  })

  it("round-trips through the reader", () => {
    expect(geoPointOf(toEwkt({ lat: -33.8688, lng: 151.2093 }))).toEqual({ lat: -33.8688, lng: 151.2093 })
  })
})

describe("checkLatLng", () => {
  it("accepts a point in range", () => {
    expect(checkLatLng("51.5072", "-0.1276")).toEqual({ ok: true, point: LONDON })
    expect(checkLatLng(" -90 ", "180")).toEqual({ ok: true, point: { lat: -90, lng: 180 } })
  })

  it("reads both boxes empty as no point", () => {
    expect(checkLatLng("", "  ")).toEqual({ ok: true, point: null })
  })

  it.each([
    ["91", "0", "Latitude must be between -90 and 90"],
    ["-90.0001", "0", "Latitude must be between -90 and 90"],
    ["0", "180.5", "Longitude must be between -180 and 180"],
    ["0", "-200", "Longitude must be between -180 and 180"],
    ["51.5", "", "Enter a longitude too, or clear both"],
    ["", "-0.12", "Enter a latitude too, or clear both"],
    ["north", "0", "Latitude must be a number"],
    ["0", "1e400", "Longitude must be a number"],
    ["0x10", "0", "Latitude must be a number"],
  ])("refuses lat %j lng %j", (lat, lng, message) => {
    expect(checkLatLng(lat, lng)).toEqual({ ok: false, message })
  })
})

describe("formatGeoPoint", () => {
  it("names the hemispheres, so latitude and longitude cannot be read the wrong way round", () => {
    expect(formatGeoPoint(LONDON)).toBe("51.5072° N, 0.1276° W")
    expect(formatGeoPoint({ lat: -33.8688, lng: 151.2093 })).toBe("33.8688° S, 151.2093° E")
    expect(formatGeoPoint({ lat: 0, lng: 0 })).toBe("0° N, 0° E")
    expect(formatGeoPoint({ lat: 12.3456789, lng: 1 })).toBe("12.345679° N, 1° E")
  })
})
