import React from "react"
import { FunctionSecrets } from "./FunctionSecrets.js"

/**
 * The project's data hooks run as functions, so they read the same secrets from `ctx.env` that the
 * Functions section manages. This page shows that one component. It is not Authentication > Hooks,
 * which is for auth events.
 */
export function Hooks(): React.ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[0.8rem] text-muted-foreground m-0">
        Data hooks run as functions and read these secrets from <code>ctx.env</code>, the same secrets the
        Functions section manages.
      </p>
      <FunctionSecrets />
    </div>
  )
}
