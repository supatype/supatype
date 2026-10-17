/**
 * What the control plane's `/auth/login` and `/auth/refresh` answer: the session's tokens on
 * success, `{ error, message }` on failure. Each field is read with a check, so a body that is not
 * JSON, or lacks a field, reads as that field being absent.
 */

import { isJsonObject, isNumber, isString } from "@supatype/shared"

export interface AuthAnswer {
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  email?: string
  /** The server's reason, for a refusal: its `message`, else its `error`. */
  failure?: string
}

/** `body` read as an auth answer. */
export function readAuthAnswer(body: unknown): AuthAnswer {
  const json = isJsonObject(body) ? body : {}
  const { access_token, refresh_token, expires_in, message, error, user } = json
  const email = isJsonObject(user) ? user["email"] : undefined
  const failure = isString(message) ? message : isString(error) ? error : undefined
  return {
    ...(isString(access_token) && { accessToken: access_token }),
    ...(isString(refresh_token) && { refreshToken: refresh_token }),
    ...(isNumber(expires_in) && { expiresIn: expires_in }),
    ...(isString(email) && { email }),
    ...(failure !== undefined && { failure }),
  }
}
