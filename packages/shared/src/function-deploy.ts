import { isArrayOf, isRecordOf, isShape, isString, optional, type FromShape } from "./json.js"

const FUNCTION_DEPLOY_ENTRY = {
  name: isString,
  source: isString,
  entrypoint: optional(isString),
  files: optional(isRecordOf(isString)),
} as const

const FUNCTION_DEPLOY_BODY = {
  functions: isArrayOf(isShape(FUNCTION_DEPLOY_ENTRY)),
  serviceRole: optional(isArrayOf(isString)),
} as const

/**
 * One function in a deploy: its name; `source`, its entry module; `entrypoint`, that module's path
 * as `<name>/index.ts`; and for a function of more than one file, `files`, every file by a `/` path
 * under the function's directory. The reader still checks the name against the function-name rule
 * and every path in `files` against its directory.
 */
export const isFunctionDeployEntry = isShape(FUNCTION_DEPLOY_ENTRY)
export type FunctionDeployEntry = FromShape<typeof FUNCTION_DEPLOY_ENTRY>

/**
 * `POST /projects/:ref/functions/deploy`, on Cloud and on a self-hosted control plane: every
 * function in one request, so a self-hosted worker restarts once a deploy; and `serviceRole`, the
 * routes granted the service-role key, which the platform replaces wholesale when it is present.
 */
export const isFunctionDeployBody = isShape(FUNCTION_DEPLOY_BODY)
export type FunctionDeployBody = FromShape<typeof FUNCTION_DEPLOY_BODY>
