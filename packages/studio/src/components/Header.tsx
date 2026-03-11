import React from "react"

interface HeaderProps {
  title?: string
  actions?: React.ReactNode
}

/** Page-level action bar. Title is optional (TopBar breadcrumbs show context). */
export function Header({ title, actions }: HeaderProps): React.ReactElement {
  if (!title && !actions) return <>{null}</>
  return (
    <div className="flex items-center justify-between mb-4">
      {title ? <h2 className="text-lg font-semibold text-foreground">{title}</h2> : <div />}
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
