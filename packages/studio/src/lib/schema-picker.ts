/**
 * Prefer the developer's app schema over auth/internal bookkeeping.
 * Dedicated / self-host stacks use `public`; fall back to first listed schema.
 */
export function pickDefaultSchema(schemas: string[]): string {
  if (schemas.length === 0) return "public"
  if (schemas.includes("public")) return "public"
  const app = schemas.find(
    (s) =>
      s !== "auth" &&
      s !== "extensions" &&
      s !== "storage" &&
      !s.startsWith("_") &&
      !s.endsWith("_auth") &&
      !s.endsWith("_internal"),
  )
  return app ?? schemas[0]!
}
