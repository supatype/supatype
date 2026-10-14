// The schema extension-schema-e2e.sh pushes to a fresh stack: one field of each kind that needs a
// Postgres extension. `GeoPoint` and `Geo` are PostGIS `geography` columns and `Vector<3>` is a
// pgvector column, so the first push creates both extensions; `UUID` keys use `gen_random_uuid()`.
// The indexes are the ones each kind is searched with: GiST for a point, HNSW (cosine distance,
// the default) for a vector.
import type { Geo, GeoPoint, Model, Optional, Public, UUID, Vector } from "@supatype/types"

export type Place = Model<{
  id: UUID
  name: string
  location: Optional<GeoPoint>
  area: Optional<Geo>
  embedding: Optional<Vector<3>>
}, {
  access: { read: Public; create: Public; update: Public; delete: Public }
  indexes: [
    { fields: ["location"], using: "gist" },
    { fields: ["embedding"], using: "hnsw" },
  ]
}>
