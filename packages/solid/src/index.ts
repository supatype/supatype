// @supatype/solid — Solid.js primitives for Supatype

export { SupatypeContext, useSupatype } from "./context.js"

export { createQuery } from "./createQuery.js"
export type { QueryOptions, QueryResult } from "./createQuery.js"

export { createMutation } from "./createMutation.js"
export type { MutationResult, MutationOperation, MutationOptions } from "./createMutation.js"

export { createAuth } from "./createAuth.js"
export type { AuthResult } from "./createAuth.js"

export { createSubscription } from "./createSubscription.js"
export type { SubscriptionOptions, SubscriptionResult } from "./createSubscription.js"

export { createFunction } from "./createFunction.js"
export type { FunctionResult } from "./createFunction.js"
