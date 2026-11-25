// Generated from release/images.json by scripts/release-images.mjs. Do not edit: run
// `bash scripts/pin.sh set <engine|server|postgres> <tag>`, which rewrites both.
export const PINNED_IMAGES = {
  engine: { image: "supatype/schema-engine", tag: "v0.11.1", commit: "e74f8c082225f13028746301b5d8be93a9fce1a9" },
  server: { image: "supatype/server", tag: "v2.5.2-e2e.1b79e2bc", commit: "1b79e2bc5a2b30094433a41902f0d87d9759f85d" },
  postgres: { image: "supatype/postgres", tag: "17.2.16", commit: "ff4a061e5bc49eebbf8b881812d028b4774d474b" },
} as const
