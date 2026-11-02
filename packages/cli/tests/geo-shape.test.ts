import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

/**
 * `Geo` claimed point, polygon or linestring, but every Geo field compiled to a
 * `GEOGRAPHY(POINT, 4326)` column. The engine writes `GEOGRAPHY(<geoType>, <srid>)` for any shape,
 * so the shape is taken from `Geo<"polygon">` and a bare `Geo` stays a point.
 */

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function geoField(declaration: string): unknown {
  const dir = mkdtempSync(join(tmpdir(), "supatype-geo-"))
  dirs.push(dir)
  const path = join(dir, "schema.ts")
  writeFileSync(
    path,
    `import type { Model, UUID, Geo } from "@supatype/types"\nexport type Place = Model<{\n  id: UUID\n  area: ${declaration}\n}>\n`,
    "utf8",
  )
  return extractSchemaAstFromTypes(path, dir)?.models[0]?.fields["area"]
}

describe("Geo fields", () => {
  it("default to a WGS84 point", () => {
    expect(geoField("Geo")).toMatchObject({ kind: "geo", geoType: "point", srid: 4326 })
  })

  it.each(["point", "polygon", "linestring"])("take the %s shape from Geo<>", (shape) => {
    expect(geoField(`Geo<"${shape}">`)).toMatchObject({ kind: "geo", geoType: shape, srid: 4326 })
  })

  it("refuse a shape Geo does not have", () => {
    expect(() => geoField(`Geo<"circle">`)).toThrow(/area.*Geo<"circle">.*point, polygon or linestring/s)
  })
})
