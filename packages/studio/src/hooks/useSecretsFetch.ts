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
 * serves the shared store only, at `/projects/:ref/functions/env`, reached with the platform session.
 */
export function useSecretsFetch(scope: SecretScope): SecretsFetch {
  const client = useAdminClient()
  const { platformUrl, projectRef } = usePlatform()
  const name = scope.kind === "function" ? scope.name : null
  return useCallback((path, init) => {
    if (platformUrl !== undefined && projectRef !== undefined) {
      // Never answer a function's own scope from the project's shared store.
      if (name !== null) return Promise.reject(new Error("Cloud keeps secrets for the whole project, not for one function"))
      return projectFetch(cloudTarget(platformUrl), projectRef)(`/functions/env${path}`, init)
    }
    const base = name === null ? "/env" : `/${encodeURIComponent(name)}/env`
    return functionsAdminFetch(client, `${base}${path}`, init)
  }, [client, platformUrl, projectRef, name])
}
