import React, { useEffect } from "react"
import { createPortal } from "react-dom"
import { cn } from "../lib/utils.js"

interface SlidePanelProps {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string | undefined
  /** Tailwind max-w-* class. Defaults to "max-w-[480px]". */
  width?: string
  children: React.ReactNode
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

export function SlidePanel({
  open,
  onClose,
  title,
  subtitle,
  width = "max-w-[480px]",
  children,
}: SlidePanelProps): React.ReactElement {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [open, onClose])

  return createPortal(
    <div className={cn("fixed inset-0 z-50", !open && "pointer-events-none")}>
      {/* Backdrop */}
      <div
        className={cn(
          "absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-300",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
        aria-hidden
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal={open}
        className={cn(
          "absolute right-0 top-0 h-full w-full flex flex-col",
          "bg-background border-l border-border shadow-2xl",
          "transition-transform duration-300 ease-in-out",
          width,
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-border shrink-0">
          <div className="min-w-0 pr-3">
            <h2 className="text-sm font-semibold text-foreground truncate">{title}</h2>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5 break-all font-mono">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center w-7 h-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors -mr-1"
            aria-label="Close panel"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-5">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}
