// Generated from release/images.json by scripts/release-images.mjs. Do not edit: run
// `bash scripts/pin.sh set <engine|server|postgres> <tag>`, which rewrites both.
export const PINNED_IMAGES = {
  engine: { image: "supatype/schema-engine", tag: "v0.8.0", commit: "878b4980e53dfd959ad65eecf9df4224f4d611d6" },
  server: { image: "supatype/server", tag: "v2.3.0", commit: "f8e3a519658447a7db341b8282923031110ed3e3" },
  postgres: { image: "supatype/postgres", tag: "17.2.12", commit: "ab9020f7691dced4875634dc88dfe500968faa5a" },
} as const
