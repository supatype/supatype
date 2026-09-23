import type { ClackApi } from "../clack-api.js"

let activeFlowApi: ClackApi | null = null

export function setActiveFlowApi(api: ClackApi | null): void {
  activeFlowApi = api
}

export function getActiveFlowApi(): ClackApi | null {
  return activeFlowApi
}
