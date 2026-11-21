// Generated from release/images.json by scripts/release-images.mjs. Do not edit: run
// `bash scripts/pin.sh set <engine|server|postgres> <tag>`, which rewrites both.
export const PINNED_IMAGES = {
  engine: { image: "supatype/schema-engine", tag: "v0.11.0", commit: "904021e6fb1d74394ab8b0d25c24720523ad0329" },
  server: { image: "supatype/server", tag: "v2.5.1-e2e.d07b10d7", commit: "d07b10d7251d624870e5905e1c4ca5e290c6a46e" },
  postgres: { image: "supatype/postgres", tag: "17.2.99", commit: "5a8170ce5ca01da3f03e38f28fa6bc4aa23b3f6c" },
} as const
