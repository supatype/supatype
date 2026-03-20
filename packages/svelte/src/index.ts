// @supatype/svelte — Svelte stores for Supatype

export { setSupatypeClient, getSupatypeClient } from "./context.js"

export { createQuery } from "./createQuery.js"
export type { QueryOptions, QueryStore } from "./createQuery.js"

export { createMutation } from "./createMutation.js"
export type { MutationStore, MutationOperation, MutationOptions } from "./createMutation.js"

export { createAuth } from "./createAuth.js"
export type { AuthStore } from "./createAuth.js"

export { createSubscription } from "./createSubscription.js"
export type { SubscriptionOptions, SubscriptionStore } from "./createSubscription.js"

export { createFunction } from "./createFunction.js"
export type { FunctionStore } from "./createFunction.js"
