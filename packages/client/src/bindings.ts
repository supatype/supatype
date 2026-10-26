/**
 * `@supatype/client/bindings`: what the Vue, Svelte and Solid bindings share.
 *
 * Kept off the main entry on purpose. These are the bindings' building blocks, not API an app is
 * meant to call, and everything on the main entry is a promise to every app. An app subscribes
 * through `from(table).subscribe()` or its framework's binding instead.
 */
export { watchTable, subscribeToTable, subscriptionViewOf, applyRowChange } from "./table-subscription.js"
export type {
  SubscriptionState,
  SubscriptionView,
  TableWatchOptions,
  TableWatchHandlers,
  TableSubscribeOptions,
  TableSubscription,
} from "./table-subscription.js"
