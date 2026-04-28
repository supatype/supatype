import React, { useEffect } from "react"
import { createPortal } from "react-dom"

interface SlideoverProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
}

export function Slideover({ open, onClose, title, children }: SlideoverProps): React.ReactElement {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  return createPortal(
    <>
      <div
        className="st-slideover-backdrop"
        style={{ opacity: open ? 1 : 0, pointerEvents: open ? "auto" : "none" }}
        onClick={onClose}
        aria-hidden
      />
      <div
        className={`st-slideover${open ? " st-slideover--open" : ""}`}
        role="dialog"
        aria-modal={open}
        aria-label={title}
      >
        <div className="st-slideover-header">
          <h2 className="st-slideover-title">{title}</h2>
          <button type="button" className="st-btn st-btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="st-slideover-body">
          {children}
        </div>
      </div>
    </>,
    document.body,
  )
}
