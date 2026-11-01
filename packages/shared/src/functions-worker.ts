/**
 * How long Docker gives the functions worker to stop before it kills it, in seconds: the compose
 * file's `stop_grace_period` and the control plane's `docker restart -t`. One Docker killed it 3 s
 * after SIGTERM (round 6, N29), cutting off the drain that lets requests in flight finish.
 */
export const FUNCTIONS_WORKER_STOP_GRACE_SECONDS = 10

/**
 * How long the worker in a compose stack lets requests in flight finish when it is stopped
 * (`SUPATYPE_FUNCTIONS_DRAIN_MS`, functions-worker stop.ts): a second under its stop grace, so it
 * exits by itself before Docker kills it. Its own default, 4 s, is for dev, where the process
 * manager kills it after 5 s; in a stack it cut off every function with more left (round 6b, N29).
 */
export const FUNCTIONS_WORKER_DRAIN_MS = (FUNCTIONS_WORKER_STOP_GRACE_SECONDS - 1) * 1000

/**
 * The file in a stack's .supatype that names the public functions given the service-role key,
 * comma-separated. A self-hosted control plane writes it on every deploy from the `serviceRole` the
 * deploy carries, replacing the list wholesale as Cloud does, and the worker reads it on every call
 * (`SUPATYPE_SERVICE_ROLE_ROUTES_FILE`, which compose points here), so a route taken off the list
 * loses the key on its next call.
 */
export const SERVICE_ROLE_ROUTES_FILE = "service-role-routes"
