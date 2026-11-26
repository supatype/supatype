// Generated from release/images.json by scripts/release-images.mjs. Do not edit: run
// `bash scripts/pin.sh set <engine|server|postgres> <tag>`, which rewrites both.
export const PINNED_IMAGES = {
  engine: { image: "supatype/schema-engine", tag: "v0.11.2", commit: "50ca56852398d6ed0346c44782f68273af7cd049" },
  server: { image: "supatype/server", tag: "v2.6.0", commit: "8b7efeaa5cdb2ac1b251dd390e2140ae8e36d614" },
  postgres: { image: "supatype/postgres", tag: "17.2.16", commit: "ff4a061e5bc49eebbf8b881812d028b4774d474b" },
} as const
