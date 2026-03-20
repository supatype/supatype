// @supatype/vue — Vue composables for Supatype

export { supatypePlugin, useSupatype, SUPATYPE_KEY } from "./context.js"

export { useQuery } from "./useQuery.js"
export type { UseQueryOptions, UseQueryReturn } from "./useQuery.js"

export { useMutation } from "./useMutation.js"
export type { UseMutationReturn, MutationOperation, MutationOptions } from "./useMutation.js"

export { useAuth } from "./useAuth.js"
export type { UseAuthReturn } from "./useAuth.js"

export { useSubscription } from "./useSubscription.js"
export type { UseSubscriptionOptions, UseSubscriptionReturn, SubscriptionEvent } from "./useSubscription.js"

export { useFunction } from "./useFunction.js"
export type { UseFunctionReturn } from "./useFunction.js"
