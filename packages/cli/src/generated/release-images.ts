// Generated from release/images.json by scripts/release-images.mjs. Do not edit: run
// `bash scripts/pin.sh set <engine|server|postgres> <tag>`, which rewrites both.
export const PINNED_IMAGES = {
  engine: { image: "supatype/schema-engine", tag: "v0.10.1", commit: "9eb9e4b04ed2eab9268dff29b4625c429a814e5f" },
  server: { image: "supatype/server", tag: "v2.5.0", commit: "8b9ecaea62c7f3086b32c25f652c1348c152ff6d" },
  postgres: { image: "supatype/postgres", tag: "17.2.15", commit: "b10f77e32ef8e8e3030279e898434c904f5c18d7" },
} as const
