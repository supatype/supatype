/**
 * Addresses people type or guess from the sidebar's own labels, and the page each one is. A path
 * with no route answers "Page not found", which for these read as the feature being missing.
 */
export const ROUTE_ALIASES: Readonly<Record<string, string>> = {
  "scheduled-jobs": "/jobs",
  intelligence: "/ai/usage",
}
