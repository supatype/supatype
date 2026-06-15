import React, { useCallback, useMemo, useState } from "react"
import type { WidgetProps } from "./FieldWidget.js"

export type ButtonFieldValue = {
  label?: string
  href?: string
  ariaLabel?: string
  target?: "_self" | "_blank"
}

const EMPTY: ButtonFieldValue = { label: "", href: "", target: "_self" }

function parseButtonRow(row: Record<string, unknown>): ButtonFieldValue {
  const target = row.target === "_blank" ? "_blank" : "_self"
  const aria =
    typeof row.ariaLabel === "string"
      ? row.ariaLabel
      : typeof row.aria_label === "string"
        ? row.aria_label
        : undefined
  return {
    label: typeof row.label === "string" ? row.label : "",
    href: typeof row.href === "string" ? row.href : "",
    ...(aria && aria.length > 0 ? { ariaLabel: aria } : {}),
    target,
  }
}

function coerceButton(value: unknown): ButtonFieldValue {
  if (value == null) return { ...EMPTY }

  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return { ...EMPTY }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return coerceButton(JSON.parse(trimmed) as unknown)
      } catch {
        return { ...EMPTY, label: trimmed }
      }
    }
    return { ...EMPTY, label: trimmed }
  }

  if (typeof value !== "object" || Array.isArray(value)) return { ...EMPTY }

  const row = value as Record<string, unknown>
  if (typeof row.label === "string" || typeof row.href === "string") {
    return parseButtonRow(row)
  }

  // Localized JSONB map, e.g. { en: { label, href } }
  for (const nested of Object.values(row)) {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const candidate = nested as Record<string, unknown>
      if (typeof candidate.label === "string" || typeof candidate.href === "string") {
        return parseButtonRow(candidate)
      }
    }
  }

  return { ...EMPTY }
}

function isButtonEmpty(button: ButtonFieldValue): boolean {
  return !button.label?.trim() && !button.href?.trim()
}

function buttonSummary(button: ButtonFieldValue): string {
  if (isButtonEmpty(button)) return "Configure button…"
  const label = button.label?.trim() || "No label"
  const href = button.href?.trim() || "No link"
  return `${label} → ${href}`
}

function hasAdvancedValues(button: ButtonFieldValue): boolean {
  return (
    (button.ariaLabel?.trim().length ?? 0) > 0 ||
    button.target === "_blank"
  )
}

export function ButtonWidget({
  config,
  value,
  onChange,
  readOnly,
  variant = "default",
}: WidgetProps): React.ReactElement {
  const button = useMemo(() => coerceButton(value), [value])
  const [expanded, setExpanded] = useState(() => isButtonEmpty(coerceButton(value)))
  const [advancedOpen, setAdvancedOpen] = useState(() => hasAdvancedValues(button))

  const patch = useCallback(
    (partial: Partial<ButtonFieldValue>) => {
      onChange({ ...button, ...partial })
    },
    [button, onChange],
  )

  const previewLabel = button.label?.trim() || "Button"
  const fieldId = `field-${config.name}`
  const compact = variant === "meta"

  if (compact) {
    return (
      <p className="st-button-summary-line" title={buttonSummary(button)}>
        {buttonSummary(button)}
      </p>
    )
  }

  return (
    <div className="st-button-widget">
      <div className="st-button-card">
        <button
          type="button"
          className="st-button-summary"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-controls={`${fieldId}-panel`}
        >
          <span className="st-button-summary-text">{buttonSummary(button)}</span>
          <span className="st-button-summary-chevron" aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
        </button>

        {expanded && (
          <div className="st-button-panel" id={`${fieldId}-panel`}>
            <label className="st-button-subfield">
              <span className="st-button-subfield-label">Label</span>
              <input
                id={`${fieldId}-label`}
                type="text"
                className="st-input"
                value={button.label ?? ""}
                onChange={(e) => patch({ label: e.target.value })}
                readOnly={readOnly}
                placeholder="Book now"
              />
            </label>
            <label className="st-button-subfield">
              <span className="st-button-subfield-label">Link</span>
              <input
                id={`${fieldId}-href`}
                type="text"
                className="st-input"
                value={button.href ?? ""}
                onChange={(e) => patch({ href: e.target.value })}
                readOnly={readOnly}
                placeholder="/book"
                spellCheck={false}
              />
            </label>

            <button
              type="button"
              className="st-button-advanced-toggle"
              onClick={() => setAdvancedOpen((open) => !open)}
              aria-expanded={advancedOpen}
            >
              Advanced
              {hasAdvancedValues(button) && !advancedOpen ? (
                <span className="st-button-advanced-dot" title="Custom accessibility or target set" />
              ) : null}
            </button>

            {advancedOpen && (
              <div className="st-button-advanced">
                <label className="st-button-subfield">
                  <span className="st-button-subfield-label">Aria label (optional)</span>
                  <input
                    id={`${fieldId}-aria`}
                    type="text"
                    className="st-input"
                    value={button.ariaLabel ?? ""}
                    onChange={(e) => patch({ ariaLabel: e.target.value })}
                    readOnly={readOnly}
                    placeholder="Describe the action for screen readers"
                  />
                </label>
                <label className="st-button-subfield">
                  <span className="st-button-subfield-label">Open in</span>
                  <select
                    id={`${fieldId}-target`}
                    className="st-input"
                    value={button.target ?? "_self"}
                    onChange={(e) =>
                      patch({ target: e.target.value === "_blank" ? "_blank" : "_self" })
                    }
                    disabled={readOnly}
                  >
                    <option value="_self">Same tab</option>
                    <option value="_blank">New tab</option>
                  </select>
                </label>
              </div>
            )}

            <p className="st-button-preview">
              Preview:{" "}
              <a
                href={button.href || "#"}
                className="st-btn st-btn-primary st-button-preview-chip"
                target={button.target === "_blank" ? "_blank" : undefined}
                rel={button.target === "_blank" ? "noopener noreferrer" : undefined}
                aria-label={button.ariaLabel || undefined}
                onClick={(e) => e.preventDefault()}
              >
                {previewLabel}
              </a>
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
