/**
 * How long Docker gives the functions worker to stop before it kills it, in seconds: the compose
 * file's `stop_grace_period` and the control plane's `docker restart -t`. One Docker here killed it
 * 3 s after SIGTERM (round 6, N29), cutting off the drain that lets requests in flight finish. Set
 * comfortably above the worker's own drain (functions-worker stop.ts, 4 s).
 */
export const FUNCTIONS_WORKER_STOP_GRACE_SECONDS = 10
