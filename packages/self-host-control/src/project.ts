import { HttpError } from "./http.js"

/** The project directory mounted into the control plane. */
export function projectRoot(): string {
  return process.env["SUPATYPE_PROJECT_ROOT"] ?? "/project"
}

/** The one project ref this control plane serves. */
export function projectRef(): string {
  return process.env["SUPATYPE_PROJECT_REF"] ?? "project"
}

/** Refuse a request addressed to any project but this one, as an unknown project. */
export function assertProject(ref: string): void {
  if (ref !== projectRef()) {
    throw new HttpError(404, "not_found", `Unknown project ref: ${ref}`)
  }
}
