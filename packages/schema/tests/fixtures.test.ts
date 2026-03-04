import { describe, it, expect } from "vitest"
import { serialiseSchema } from "../src/serialiser.js"

import { fixtures as basicBlog } from "./fixtures/basic_blog.js"
import { fixtures as ecommerce } from "./fixtures/ecommerce.js"
import { fixtures as saasMultiTenant } from "./fixtures/saas_multi_tenant.js"
import { fixtures as cmsContent } from "./fixtures/cms_content.js"
import { fixtures as geospatial } from "./fixtures/geospatial.js"
import { fixtures as vectorSearch } from "./fixtures/vector_search.js"
import { fixtures as selfReferential } from "./fixtures/self_referential.js"
import { fixtures as manyToMany } from "./fixtures/many_to_many.js"
import { fixtures as softDeleteFixture } from "./fixtures/soft_delete.js"
import { fixtures as kitchenSink } from "./fixtures/kitchen_sink.js"

const allFixtures = [
  { name: "basic_blog", models: basicBlog },
  { name: "ecommerce", models: ecommerce },
  { name: "saas_multi_tenant", models: saasMultiTenant },
  { name: "cms_content", models: cmsContent },
  { name: "geospatial", models: geospatial },
  { name: "vector_search", models: vectorSearch },
  { name: "self_referential", models: selfReferential },
  { name: "many_to_many", models: manyToMany },
  { name: "soft_delete", models: softDeleteFixture },
  { name: "kitchen_sink", models: kitchenSink },
]

describe("test fixtures", () => {
  for (const { name, models } of allFixtures) {
    describe(name, () => {
      it("serialises without error", () => {
        const ast = serialiseSchema(models as Record<string, any>)
        expect(ast).toBeDefined()
        expect(ast.models.length).toBeGreaterThan(0)
      })

      it("every model has a name and tableName", () => {
        const ast = serialiseSchema(models as Record<string, any>)
        for (const m of ast.models) {
          expect(m.name).toBeTruthy()
          expect(m.tableName).toBeTruthy()
        }
      })

      it("every model has at least one field", () => {
        const ast = serialiseSchema(models as Record<string, any>)
        for (const m of ast.models) {
          expect(Object.keys(m.fields).length).toBeGreaterThan(0)
        }
      })

      it("every field has a kind", () => {
        const ast = serialiseSchema(models as Record<string, any>)
        for (const m of ast.models) {
          for (const [fieldName, fieldDef] of Object.entries(m.fields)) {
            expect(fieldDef.kind, `${m.name}.${fieldName} should have a kind`).toBeTruthy()
          }
        }
      })

      it("produces valid JSON", () => {
        const ast = serialiseSchema(models as Record<string, any>)
        const jsonStr = JSON.stringify(ast)
        expect(() => JSON.parse(jsonStr)).not.toThrow()
      })

      it("relation fields have target and cardinality", () => {
        const ast = serialiseSchema(models as Record<string, any>)
        for (const m of ast.models) {
          for (const [fieldName, fieldDef] of Object.entries(m.fields)) {
            if (fieldDef.kind === "relation") {
              expect(fieldDef.target, `${m.name}.${fieldName} should have target`).toBeTruthy()
              expect(fieldDef.cardinality, `${m.name}.${fieldName} should have cardinality`).toBeTruthy()
            }
          }
        }
      })

      it("scalar fields have pgType", () => {
        const ast = serialiseSchema(models as Record<string, any>)
        const nonPgTypeKinds = ["relation", "timestamps", "publishable", "softDelete"]
        for (const m of ast.models) {
          for (const [fieldName, fieldDef] of Object.entries(m.fields)) {
            if (!nonPgTypeKinds.includes(fieldDef.kind as string)) {
              expect(fieldDef.pgType, `${m.name}.${fieldName} should have pgType`).toBeTruthy()
            }
          }
        }
      })
    })
  }
})
