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
export { FUNCTION_NAME, FUNCTION_NAME_RULE, isFunctionName } from "./function-name.js"
export {
  MAX_IDENTIFIER_BYTES,
  keptName,
  makeObjectName,
  utf8ByteLength,
  versionsTableName,
} from "./identifier-names.js"
export { pathInside, resolveInside, type PathInsideOptions } from "./path-inside.js"
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
