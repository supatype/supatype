/**
 * Who a push through this control plane is recorded as being from, for the audit trail.
 *
 * Only the gateway reaches this server: every request presents the secret it alone holds
 * (`auth.ts`). The gateway forwards `/platform/v1` only for a caller holding the service-role key
 * (supatype-auth `platformproxy`, behind `RequireServiceRoleMiddleware`), and forwards no user
 * identity with it. So the caller is the service role, and that is what is recorded, as verified.
 * Whoever the client says it is (`pushed_by` in the body) is its own claim, and is not read.
 *
 * The gateway checks the key in `dev` mode too (SC1). A gateway from before that skipped the check
 * in `dev` mode; this server cannot tell, so a push through one is recorded the same way.
 */
export const PUSH_IDENTITY = { pushedBy: "service_role", pushedByVerified: true } as const
