import { describe, expectTypeOf, it } from "vitest";
describe("@supatype/types primitives", () => {
    it("exposes branded field types with structural use-site compatibility", () => {
        expectTypeOf().toMatchTypeOf();
        expectTypeOf().toMatchTypeOf();
        expectTypeOf().toMatchTypeOf();
    });
    it("supports relation wrappers and optional modifier composition", () => {
        expectTypeOf().toEqualTypeOf();
        expectTypeOf().toEqualTypeOf();
    });
    it("preserves model metadata markers for extractor discovery", () => {
        expectTypeOf().toHaveProperty("id");
        expectTypeOf().toHaveProperty("body");
    });
});
//# sourceMappingURL=primitives.test.js.map