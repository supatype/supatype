// Generated from release/images.json by scripts/release-images.mjs. Do not edit: run
// `bash scripts/pin.sh set <engine|server|postgres> <tag>`, which rewrites both.
export const PINNED_IMAGES = {
  engine: { image: "supatype/schema-engine", tag: "v0.12.0-e2e.ad61bf1", commit: "ad61bf131268bcd51ef727fa7be98edf0641eb6b" },
  server: { image: "supatype/server", tag: "v2.5.2-e2e.1b79e2bc", commit: "1b79e2bc5a2b30094433a41902f0d87d9759f85d" },
  postgres: { image: "supatype/postgres", tag: "17.2.99", commit: "5a8170ce5ca01da3f03e38f28fa6bc4aa23b3f6c" },
} as const
