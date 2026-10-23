import React, { useCallback, useMemo, useState } from "react"
import type { WidgetProps } from "./FieldWidget.js"
import { isJsonObject } from "../lib/json.js"
import { ButtonLink, Card, DisclosureButton, Input, Select, TextLink } from "../components/ui.js"

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

/** A button stored as text: JSON for one, read as such, or else the text as its label. */
function buttonFromText(value: string): ButtonFieldValue {
  const trimmed = value.trim()
  if (!trimmed) return { ...EMPTY }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return coerceButton(JSON.parse(trimmed))
    } catch {
      return { ...EMPTY, label: trimmed }
    }
  }
  return { ...EMPTY, label: trimmed }
}

const hasButtonFields = (row: Record<string, unknown>): boolean => typeof row.label === "string" || typeof row.href === "string"

function coerceButton(value: unknown): ButtonFieldValue {
  if (value == null) return { ...EMPTY }
  if (typeof value === "string") return buttonFromText(value)
  if (!isJsonObject(value)) return { ...EMPTY }
  if (hasButtonFields(value)) return parseButtonRow(value)
  // Localized JSONB map, e.g. { en: { label, href } }
  const localized = Object.values(value).find((candidate) => isJsonObject(candidate) && hasButtonFields(candidate))
  return isJsonObject(localized) ? parseButtonRow(localized) : { ...EMPTY }
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

/** A button value and the one way to change part of it, shared by the panel's pieces. */
interface ButtonEdit {
  button: ButtonFieldValue
  patch: (partial: Partial<ButtonFieldValue>) => void
  readOnly: boolean
}

/** One labelled box in the panel: its name above the control. */
function SubField({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

/** What the button looks like with these values. A preview: it does not follow its link. */
function ButtonPreview({ button }: { button: ButtonFieldValue }): React.ReactElement {
  const newTab = button.target === "_blank"
  return (
    <p className="mt-0.5 text-xs text-muted-foreground">
      Preview:{" "}
      <ButtonLink
        variant="primary"
        size="xs"
        className="pointer-events-none"
        href={button.href || "#"}
        {...(newTab && { target: "_blank", rel: "noopener noreferrer" })}
        {...(button.ariaLabel ? { "aria-label": button.ariaLabel } : {})}
        onClick={(e) => e.preventDefault()}
      >
        {button.label?.trim() || "Button"}
      </ButtonLink>
    </p>
  )
}

/** The aria label and where the link opens, behind Advanced. */
function AdvancedFields({ edit, fieldId }: { edit: ButtonEdit; fieldId: string }): React.ReactElement {
  const { button, patch, readOnly } = edit
  return (
    <div className="flex flex-col gap-2.5 pt-0.5">
      <SubField label="Aria label (optional)">
        <Input id={`${fieldId}-aria`} type="text" value={button.ariaLabel ?? ""} onChange={(e) => patch({ ariaLabel: e.target.value })} readOnly={readOnly} placeholder="Describe the action for screen readers" />
      </SubField>
      <SubField label="Open in">
        <Select id={`${fieldId}-target`} className="w-full" value={button.target ?? "_self"} onChange={(e) => patch({ target: e.target.value === "_blank" ? "_blank" : "_self" })} disabled={readOnly}>
          <option value="_self">Same tab</option>
          <option value="_blank">New tab</option>
        </Select>
      </SubField>
    </div>
  )
}

/** The panel under the summary: label, link, the advanced settings on request, and the preview. */
function ButtonPanel({ edit, fieldId, advanced }: {
  edit: ButtonEdit
  fieldId: string
  advanced: { open: boolean; toggle: () => void }
}): React.ReactElement {
  const { button, patch, readOnly } = edit
  return (
    <div className="flex flex-col gap-2.5 border-t border-border p-3" id={`${fieldId}-panel`}>
      <SubField label="Label">
        <Input id={`${fieldId}-label`} type="text" value={button.label ?? ""} onChange={(e) => patch({ label: e.target.value })} readOnly={readOnly} placeholder="Book now" />
      </SubField>
      <SubField label="Link">
        <Input id={`${fieldId}-href`} type="text" value={button.href ?? ""} onChange={(e) => patch({ href: e.target.value })} readOnly={readOnly} placeholder="/book" spellCheck={false} />
      </SubField>
      <TextLink tone="muted" className="self-start text-xs underline" onClick={advanced.toggle} aria-expanded={advanced.open}>
        Advanced
        {hasAdvancedValues(button) && !advanced.open ? (
          <span className="h-1.5 w-1.5 rounded-full bg-primary" title="Custom accessibility or target set" />
        ) : null}
      </TextLink>
      {advanced.open && <AdvancedFields edit={edit} fieldId={fieldId} />}
      <ButtonPreview button={button} />
    </div>
  )
}

export function ButtonWidget({ config, value, onChange, readOnly, variant = "default" }: WidgetProps): React.ReactElement {
  const button = useMemo(() => coerceButton(value), [value])
  const [expanded, setExpanded] = useState(() => isButtonEmpty(coerceButton(value)))
  const [advancedOpen, setAdvancedOpen] = useState(() => hasAdvancedValues(button))
  const patch = useCallback((partial: Partial<ButtonFieldValue>) => { onChange({ ...button, ...partial }) }, [button, onChange])
  const fieldId = `field-${config.name}`
  const summary = buttonSummary(button)

  if (variant === "meta") {
    return <p className="m-0 truncate text-[0.8rem] text-muted-foreground" title={summary}>{summary}</p>
  }

  return (
    <Card className="overflow-hidden">
      <DisclosureButton id={fieldId} open={expanded} aria-controls={`${fieldId}-panel`} className="justify-between gap-3 bg-secondary px-3 py-2 text-[0.85rem] text-foreground hover:bg-accent" onClick={() => setExpanded((open) => !open)}>
        <span className="min-w-0 truncate font-medium">{summary}</span>
        <span className="shrink-0 text-xs text-muted-foreground" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      </DisclosureButton>
      {expanded && <ButtonPanel edit={{ button, patch, readOnly }} fieldId={fieldId} advanced={{ open: advancedOpen, toggle: () => setAdvancedOpen((open) => !open) }} />}
    </Card>
  )
}
