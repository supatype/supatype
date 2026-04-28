/**
 * Host port published for Kong in local Docker Compose. Kong still listens on
 * 8000 inside the container; this avoids clashing with other tools on :8000.
 */
export const LOCAL_KONG_HOST_PORT = 18473

export function localKongBaseUrl(): string {
  return `http://localhost:${LOCAL_KONG_HOST_PORT}`
}
