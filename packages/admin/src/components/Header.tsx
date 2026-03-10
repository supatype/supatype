import React from "react"
import { LocaleSwitcher } from "./LocaleSwitcher.js"

interface HeaderProps {
  title: string
  actions?: React.ReactNode
}

export function Header({ title, actions }: HeaderProps): React.ReactElement {
  return (
    <header className="st-header">
      <h1 className="st-header-title">{title}</h1>
      <div className="st-header-actions">
        <LocaleSwitcher />
        {actions}
      </div>
    </header>
  )
}
