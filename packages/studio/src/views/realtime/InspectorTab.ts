import type { PlatformMode, ProjectFetch } from "../../hooks/usePlatformApi.js"

/** What every Inspector tab is given: where the project's control plane is, and which kind. */
export interface InspectorApi {
  mode: PlatformMode
  fetch: ProjectFetch
}

export interface InspectorTabProps {
  api: InspectorApi
}
