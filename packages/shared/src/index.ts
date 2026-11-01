/**
 * What the CLI and the self-host control plane must read and decide the same way. Each used to keep
 * its own copy, and the copies drifted: the busy wording was widened for rollback in one and not the
 * other, and a function name the server refuses was deployed by the CLI without a word.
 */
export { ENGINE_BUSY, ENGINE_BUSY_WORDING, engineBusySentence } from "./engine-busy.js"
export {
  CAPABILITIES_TTL_MS,
  capabilitiesCache,
  rememberCapabilities,
  rememberCapabilitiesSync,
  type CapabilitiesCache,
} from "./capabilities-cache.js"
export { FUNCTION_NAME, FUNCTION_NAME_RULE, HOOK_NAME, HOOK_NAME_RULE, isFunctionName, isHookName } from "./function-name.js"
export { FUNCTION_ENTRY_FILE, functionRouteName } from "./function-routes.js"
export {
  isFunctionDeployBody,
  isFunctionDeployEntry,
  type FunctionDeployBody,
  type FunctionDeployEntry,
} from "./function-deploy.js"
export { FUNCTIONS_WORKER_DRAIN_MS, FUNCTIONS_WORKER_STOP_GRACE_SECONDS, SERVICE_ROLE_ROUTES_FILE } from "./functions-worker.js"
export { workerLoadsFile } from "./worker-files.js"
export {
  MAX_IDENTIFIER_BYTES,
  keptName,
  makeObjectName,
  utf8ByteLength,
  versionsTableName,
} from "./identifier-names.js"
export { pathInside, resolveInside, toPosixPath } from "./path-inside.js"
export {
  isArrayOf,
  isBoolean,
  isJsonObject,
  isNumber,
  isOneOf,
  isRecordOf,
  isShape,
  isString,
  isUnknown,
  nullable,
  optional,
  parseJsonObject,
  readJson,
  type FromShape,
  type Guard,
  type JsonResponse,
  type Optional,
  type ParsedJsonObject,
} from "./json.js"
export {
  ADAPTER_IMPORT,
  ADAPTER_NAME,
  HOOK_FILES_FEATURE,
  isHookDeployAnswer,
  type HookDeployAnswer,
  FLATTENED_ADAPTER_IMPORT,
  applyManifestMaps,
  flattenHookSource,
  isCacheMap,
  isHookDeployBody,
  isHookMap,
  unflattenHookSource,
  type CacheMap,
  type HookDeployBody,
  type HookMap,
  type ManifestCacheEntry,
  type ManifestHookEntry,
  type ManifestMaps,
} from "./manifest-maps.js"
