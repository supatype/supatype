// Generated from release/images.json by scripts/release-images.mjs. Do not edit: run
// `bash scripts/pin.sh set <engine|server|postgres> <tag>`, which rewrites both.
export const PINNED_IMAGES = {
  engine: { image: "supatype/schema-engine", tag: "v0.9.0", commit: "a976618b51f4b052ec43968220a0444197b2a746" },
  server: { image: "supatype/server", tag: "v2.2.2", commit: "00f0ad3e782dbcf5fbb3d2e607aa044d66ba0138" },
  postgres: { image: "supatype/postgres", tag: "17.2.12", commit: "ab9020f7691dced4875634dc88dfe500968faa5a" },
} as const
