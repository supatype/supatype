import React from "react"
import { useAdminConfig } from "../hooks/useAdminConfig.js"
import type { NavGroup, NavItem } from "../config.js"

interface SidebarProps {
  currentPath: string
  onNavigate: (path: string) => void
}

export function Sidebar({ currentPath, onNavigate }: SidebarProps): React.ReactElement {
  const config = useAdminConfig()

  return (
    <nav className="st-sidebar" role="navigation" aria-label="Admin navigation">
      {config.branding?.appName && (
        <div className="st-sidebar-brand">
          {config.branding.logo && <img src={config.branding.logo} alt="" className="st-sidebar-logo" />}
          <span className="st-sidebar-title">{config.branding.appName}</span>
        </div>
      )}
      {config.navigation.map((group) => (
        <SidebarGroup
          key={group.label}
          group={group}
          currentPath={currentPath}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  )
}

function SidebarGroup({
  group,
  currentPath,
  onNavigate,
}: {
  group: NavGroup
  currentPath: string
  onNavigate: (path: string) => void
}): React.ReactElement {
  return (
    <div className="st-sidebar-group">
      <h3 className="st-sidebar-group-label">{group.label}</h3>
      <ul className="st-sidebar-list">
        {group.items.map((item) => (
          <SidebarItem
            key={item.href}
            item={item}
            active={currentPath === item.href || currentPath.startsWith(`${item.href}/`)}
            onNavigate={onNavigate}
          />
        ))}
      </ul>
    </div>
  )
}

function SidebarItem({
  item,
  active,
  onNavigate,
}: {
  item: NavItem
  active: boolean
  onNavigate: (path: string) => void
}): React.ReactElement {
  return (
    <li className={`st-sidebar-item${active ? " st-sidebar-item--active" : ""}`}>
      <button
        type="button"
        className="st-sidebar-link"
        onClick={() => { onNavigate(item.href) }}
        aria-current={active ? "page" : undefined}
      >
        {item.label}
      </button>
    </li>
  )
}
