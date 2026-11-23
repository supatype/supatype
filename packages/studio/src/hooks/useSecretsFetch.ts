import { useCallback } from "react"
import { useAdminClient } from "./useAdminClient.js"
import { usePlatform } from "./usePlatform.js"
import { cloudTarget, projectFetch } from "./usePlatformApi.js"
import { functionsAdminFetch } from "../lib/functions-admin.js"

/** Whose secrets: every function's (the project's shared store), or one function's own. */
export type SecretScope = { kind: "shared" } | { kind: "function"; name: string }

/** A request to the secret store of one scope; `path` is "" for the list and set, "/KEY" for a removal. */
export type SecretsFetch = (path: string, init?: RequestInit) => Promise<Response>

/**
 * Where the secrets are, in each deployment mode. Self-host's gateway serves them under
 * `/admin/v1/functions`, shared at `/env` and one function's at `/NAME/env`. Cloud's control plane
 * serves both under `/projects/:ref/functions`, shared at `/env` and one function's at `/NAME/env`,
 * reached with the platform session.
 */
export function useSecretsFetch(scope: SecretScope): SecretsFetch {
  const client = useAdminClient()
  const { platformUrl, projectRef } = usePlatform()
  const name = scope.kind === "function" ? scope.name : null
  return useCallback((path, init) => {
    const base = name === null ? "/env" : `/${encodeURIComponent(name)}/env`
    if (platformUrl !== undefined && projectRef !== undefined) {
      return projectFetch(cloudTarget(platformUrl), projectRef)(`/functions${base}${path}`, init)
    }
    return functionsAdminFetch(client, `${base}${path}`, init)
  }, [client, platformUrl, projectRef, name])
}
