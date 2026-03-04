import { describe, it, expect } from "vitest"
import {
  text, richText, integer, smallInt, serial, bigSerial,
  float, boolean, date, timestamp, datetime, uuid, email,
  url, ip, cidr, macaddr, interval, tsquery, tsvector,
  bytea, money, xml, bigInt, slug, enumField, decimal,
  json, image, file, geo, vector, arrayOf,
} from "../src/fields.js"
import type { ScalarFieldMeta, SlugFieldMeta, EnumFieldMeta, DecimalFieldMeta, JsonFieldMeta, StorageFieldMeta, GeoFieldMeta, VectorFieldMeta, ArrayFieldMeta } from "../src/types.js"

describe("scalar fields", () => {
  it("text() creates TEXT field", () => {
    const f = text()
    const meta = f.__meta as ScalarFieldMeta
    expect(meta.kind).toBe("text")
    expect(meta.pgType).toBe("TEXT")
    expect(meta.required).toBe(false)
  })

  it("text({ required: true }) marks required", () => {
    const f = text({ required: true })
    expect((f.__meta as ScalarFieldMeta).required).toBe(true)
  })

  it("text({ maxLength }) adds check constraint", () => {
    const f = text({ maxLength: 100 })
    expect((f.__meta as ScalarFieldMeta).check).toContain("100")
  })

  it("integer() creates INTEGER field", () => {
    const f = integer()
    const meta = f.__meta as ScalarFieldMeta
    expect(meta.kind).toBe("integer")
    expect(meta.pgType).toBe("INTEGER")
  })

  it("integer({ min, max }) adds range check", () => {
    const f = integer({ min: 0, max: 100 })
    const meta = f.__meta as ScalarFieldMeta
    expect(meta.check).toContain(">= 0")
    expect(meta.check).toContain("<= 100")
  })

  it("smallInt() creates SMALLINT field", () => {
    const f = smallInt()
    const meta = f.__meta as ScalarFieldMeta
    expect(meta.kind).toBe("smallInt")
    expect(meta.pgType).toBe("SMALLINT")
  })

  it("serial() creates SERIAL field (always required)", () => {
    const f = serial()
    const meta = f.__meta as ScalarFieldMeta
    expect(meta.kind).toBe("serial")
    expect(meta.pgType).toBe("SERIAL")
    expect(meta.required).toBe(true)
  })

  it("bigSerial() creates BIGSERIAL field", () => {
    const f = bigSerial()
    const meta = f.__meta as ScalarFieldMeta
    expect(meta.kind).toBe("bigSerial")
    expect(meta.pgType).toBe("BIGSERIAL")
    expect(meta.required).toBe(true)
  })

  it("float() creates DOUBLE PRECISION field", () => {
    const f = float()
    expect((f.__meta as ScalarFieldMeta).pgType).toBe("DOUBLE PRECISION")
  })

  it("boolean() creates BOOLEAN field", () => {
    const f = boolean()
    expect((f.__meta as ScalarFieldMeta).pgType).toBe("BOOLEAN")
  })

  it("date() creates DATE field", () => {
    const f = date()
    const meta = f.__meta as ScalarFieldMeta
    expect(meta.kind).toBe("date")
    expect(meta.pgType).toBe("DATE")
  })

  it("timestamp() creates TIMESTAMP field (without timezone)", () => {
    const f = timestamp()
    const meta = f.__meta as ScalarFieldMeta
    expect(meta.kind).toBe("timestamp")
    expect(meta.pgType).toBe("TIMESTAMP")
  })

  it("datetime() creates TIMESTAMPTZ field", () => {
    const f = datetime()
    expect((f.__meta as ScalarFieldMeta).pgType).toBe("TIMESTAMPTZ")
  })

  it("uuid() creates UUID field", () => {
    const f = uuid()
    expect((f.__meta as ScalarFieldMeta).pgType).toBe("UUID")
  })

  it("email() creates TEXT field with email kind", () => {
    const f = email()
    const meta = f.__meta as ScalarFieldMeta
    expect(meta.kind).toBe("email")
    expect(meta.pgType).toBe("TEXT")
  })

  it("url() creates TEXT field with url kind", () => {
    const f = url()
    const meta = f.__meta as ScalarFieldMeta
    expect(meta.kind).toBe("url")
    expect(meta.pgType).toBe("TEXT")
  })

  it("ip() creates INET field", () => {
    const f = ip()
    const meta = f.__meta as ScalarFieldMeta
    expect(meta.kind).toBe("ip")
    expect(meta.pgType).toBe("INET")
  })

  it("cidr() creates CIDR field", () => {
    const f = cidr()
    const meta = f.__meta as ScalarFieldMeta
    expect(meta.kind).toBe("cidr")
    expect(meta.pgType).toBe("CIDR")
  })

  it("macaddr() creates MACADDR field", () => {
    const f = macaddr()
    const meta = f.__meta as ScalarFieldMeta
    expect(meta.kind).toBe("macaddr")
    expect(meta.pgType).toBe("MACADDR")
  })

  it("interval() creates INTERVAL field", () => {
    const f = interval()
    const meta = f.__meta as ScalarFieldMeta
    expect(meta.kind).toBe("interval")
    expect(meta.pgType).toBe("INTERVAL")
  })

  it("tsquery() creates TSQUERY field", () => {
    const f = tsquery()
    const meta = f.__meta as ScalarFieldMeta
    expect(meta.kind).toBe("tsquery")
    expect(meta.pgType).toBe("TSQUERY")
  })

  it("tsvector() creates TSVECTOR field", () => {
    const f = tsvector()
    const meta = f.__meta as ScalarFieldMeta
    expect(meta.kind).toBe("tsvector")
    expect(meta.pgType).toBe("TSVECTOR")
  })

  it("bytea() creates BYTEA field", () => {
    const f = bytea()
    const meta = f.__meta as ScalarFieldMeta
    expect(meta.kind).toBe("bytea")
    expect(meta.pgType).toBe("BYTEA")
  })

  it("money() creates MONEY field", () => {
    const f = money()
    const meta = f.__meta as ScalarFieldMeta
    expect(meta.kind).toBe("money")
    expect(meta.pgType).toBe("MONEY")
  })

  it("xml() creates XML field", () => {
    const f = xml()
    const meta = f.__meta as ScalarFieldMeta
    expect(meta.kind).toBe("xml")
    expect(meta.pgType).toBe("XML")
  })

  it("bigInt() creates BIGINT field", () => {
    const f = bigInt()
    expect((f.__meta as ScalarFieldMeta).pgType).toBe("BIGINT")
  })
})

describe("richText", () => {
  it("creates JSONB field with richText kind", () => {
    const f = richText()
    const meta = f.__meta as JsonFieldMeta
    expect(meta.kind).toBe("richText")
    expect(meta.pgType).toBe("JSONB")
  })
})

describe("slug", () => {
  it("creates slug field with from and unique defaults", () => {
    const f = slug({ from: "title" })
    const meta = f.__meta as SlugFieldMeta
    expect(meta.kind).toBe("slug")
    expect(meta.pgType).toBe("TEXT")
    expect(meta.from).toBe("title")
    expect(meta.unique).toBe(true)
  })

  it("slug unique can be overridden", () => {
    const f = slug({ from: "name", unique: false })
    expect((f.__meta as SlugFieldMeta).unique).toBe(false)
  })
})

describe("enumField", () => {
  it("creates TEXT field with values", () => {
    const f = enumField(["a", "b", "c"] as const)
    const meta = f.__meta as EnumFieldMeta
    expect(meta.kind).toBe("enum")
    expect(meta.pgType).toBe("TEXT")
    expect(meta.values).toEqual(["a", "b", "c"])
    expect(meta.required).toBe(false)
  })

  it("supports default value", () => {
    const f = enumField(["x", "y"] as const, { default: "x" })
    expect((f.__meta as EnumFieldMeta).default).toBe("x")
  })
})

describe("decimal", () => {
  it("creates NUMERIC field", () => {
    const f = decimal()
    const meta = f.__meta as DecimalFieldMeta
    expect(meta.kind).toBe("decimal")
    expect(meta.pgType).toBe("NUMERIC")
  })

  it("creates NUMERIC(p,s) when precision/scale set", () => {
    const f = decimal({ precision: 10, scale: 2 })
    const meta = f.__meta as DecimalFieldMeta
    expect(meta.pgType).toBe("NUMERIC(10, 2)")
    expect(meta.precision).toBe(10)
    expect(meta.scale).toBe(2)
  })
})

describe("json", () => {
  it("creates JSONB field", () => {
    const f = json()
    const meta = f.__meta as JsonFieldMeta
    expect(meta.kind).toBe("json")
    expect(meta.pgType).toBe("JSONB")
  })
})

describe("storage fields", () => {
  it("image() defaults to images bucket", () => {
    const f = image()
    const meta = f.__meta as StorageFieldMeta
    expect(meta.kind).toBe("image")
    expect(meta.bucket).toBe("images")
    expect(meta.pgType).toBe("JSONB")
  })

  it("file() defaults to files bucket", () => {
    const f = file()
    const meta = f.__meta as StorageFieldMeta
    expect(meta.kind).toBe("file")
    expect(meta.bucket).toBe("files")
  })

  it("custom bucket name", () => {
    const f = image({ bucket: "avatars" })
    expect((f.__meta as StorageFieldMeta).bucket).toBe("avatars")
  })
})

describe("geo", () => {
  it("defaults to point with srid 4326", () => {
    const f = geo()
    const meta = f.__meta as GeoFieldMeta
    expect(meta.kind).toBe("geo")
    expect(meta.pgType).toBe("GEOGRAPHY(POINT, 4326)")
    expect(meta.geoType).toBe("point")
  })

  it("supports polygon type", () => {
    const f = geo({ type: "polygon" })
    const meta = f.__meta as GeoFieldMeta
    expect(meta.pgType).toBe("GEOGRAPHY(POLYGON, 4326)")
    expect(meta.geoType).toBe("polygon")
  })

  it("supports custom srid", () => {
    const f = geo({ type: "point", srid: 3857 })
    expect((f.__meta as GeoFieldMeta).pgType).toBe("GEOGRAPHY(POINT, 3857)")
  })
})

describe("vector", () => {
  it("creates vector field with dimensions", () => {
    const f = vector({ dimensions: 1536 })
    const meta = f.__meta as VectorFieldMeta
    expect(meta.kind).toBe("vector")
    expect(meta.pgType).toBe("vector(1536)")
    expect(meta.dimensions).toBe(1536)
  })
})

describe("arrayOf", () => {
  it("creates array field with element type", () => {
    const f = arrayOf("TEXT")
    const meta = f.__meta as ArrayFieldMeta
    expect(meta.kind).toBe("array")
    expect(meta.pgType).toBe("TEXT[]")
    expect(meta.elementType).toBe("TEXT")
    expect(meta.required).toBe(false)
  })

  it("supports required", () => {
    const f = arrayOf("INTEGER", { required: true })
    expect((f.__meta as ArrayFieldMeta).required).toBe(true)
  })
})

describe("common options", () => {
  it("unique flag", () => {
    const f = text({ unique: true })
    expect((f.__meta as ScalarFieldMeta).unique).toBe(true)
  })

  it("index flag", () => {
    const f = text({ index: true })
    expect((f.__meta as ScalarFieldMeta).index).toBe(true)
  })

  it("default value", () => {
    const f = boolean({ default: { kind: "value", value: true } })
    expect((f.__meta as ScalarFieldMeta).default).toEqual({ kind: "value", value: true })
  })

  it("default expression", () => {
    const f = datetime({ default: { kind: "now" } })
    expect((f.__meta as ScalarFieldMeta).default).toEqual({ kind: "now" })
  })
})
