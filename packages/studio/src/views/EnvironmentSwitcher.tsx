import React from "react"
import { useCloud } from "../hooks/useCloud.js"
import { cn } from "../lib/utils.js"

export function EnvironmentSwitcher(): React.ReactElement {
  const { activeEnvironment, setActiveEnvironment, features } = useCloud()

  if (!features.environments) return <React.Fragment />

  const envs = ["production", "staging", "preview"] as const

  return (
    <div className="flex p-0.5 rounded-lg bg-muted">
      {envs.map((env) => (
        <button
          key={env}
          type="button"
          onClick={() => setActiveEnvironment(env)}
          className={cn(
            "px-3 py-1 text-xs font-medium rounded-md transition-colors capitalize",
            activeEnvironment === env
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {env}
        </button>
      ))}
    </div>
  )
}
