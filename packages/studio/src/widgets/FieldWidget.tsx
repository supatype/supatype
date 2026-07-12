import React from "react"
import type { FieldConfig } from "../config.js"
import { TextWidget } from "./TextWidget.js"
import { NumberWidget } from "./NumberWidget.js"
import { BooleanWidget } from "./BooleanWidget.js"
import { DateWidget } from "./DateWidget.js"
import { SelectWidget } from "./SelectWidget.js"
import { ImageWidget } from "./ImageWidget.js"
import { FileWidget } from "./FileWidget.js"
import { RelationWidget } from "./RelationWidget.js"
import { RichTextWidget } from "./RichTextWidget.js"
import { JsonWidget } from "./JsonWidget.js"
import { BlocksWidget } from "./BlocksWidget.js"
import { PublishWidget } from "./PublishWidget.js"
import { ColorWidget } from "./ColorWidget.js"
import { XmlWidget } from "./XmlWidget.js"
import { SlugWidget } from "./SlugWidget.js"
import { DerivedTextWidget } from "./DerivedTextWidget.js"
import { ButtonWidget } from "./ButtonWidget.js"

export interface WidgetProps {
  config: FieldConfig
  value: unknown
  onChange: (value: unknown) => void
  readOnly: boolean
  /** Full record for cross-field widgets (e.g. slug from title). */
  record?: Record<string, unknown>
  currentLocale?: string
  defaultLocale?: string
  /** Bumps when the loaded row changes so slug auto/manual state re-initialises. */
  recordSyncKey?: string
  /**
   * When true (new record, not yet persisted), slug tracks the source field as you type.
   * When false (loaded row), only the refresh control copies source → slug.
   */
  slugFollowSource?: boolean
  /** Compact read-only styling for the metadata sidebar. */
  variant?: "default" | "meta"
  /** Default-locale text shown when the active locale has no translation yet. */
  localePlaceholder?: string | undefined
}

/**
 * Engine admin JSON declares `derivedText`; older bundles may still expose `sources`/`template`
 * on `widget: "text"` — route those to DerivedTextWidget so previews track like slug.
 */
export function normalizeDerivedPreviewFieldConfig(config: FieldConfig): FieldConfig {
  if (config.widget === "derivedText") return config
  const baseOk = config.widget === "text" || config.widget === "textarea"
  if (!baseOk) return config

  const raw = config.options?.["sources"]
  const sources = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []
  const template =
    typeof config.options?.["template"] === "string" ? config.options["template"].trim() : ""
  if (sources.length === 0 && template.length === 0) return config

  const explicitMultiline = config.options?.["multiline"] === true
  return {
    ...config,
    widget: "derivedText",
    options: {
      ...(config.options ?? {}),
      ...(config.widget === "textarea" || explicitMultiline ? { multiline: true } : {}),
    },
  }
}

function TranslationIcon(): React.ReactElement {
  return (
    <svg
      className="st-field-localized-icon"
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m5 8 6 6" />
      <path d="m4 14 6-6 2-3" />
      <path d="M2 5h12" />
      <path d="M7 2v3" />
      <path d="m22 22-5-10-5 10" />
      <path d="M14 18h6" />
    </svg>
  )
}

export function FieldWidget(props: WidgetProps): React.ReactElement {
  const config = normalizeDerivedPreviewFieldConfig(props.config)
  const next = { ...props, config }
  const variant = props.variant ?? "default"

  return (
    <div
      className={`st-field st-field--${config.widget}${config.required ? " st-field--required" : ""}${variant === "meta" ? " st-field--meta" : ""}`}
    >
      <label className="st-field-label" htmlFor={`field-${config.name}`}>
        {config.label}
        {config.required && <span className="st-field-required" aria-label="required"> *</span>}
        {config.localized && (
          <span className="st-field-localized" title="This field is translated" aria-label="Translated field">
            <TranslationIcon />
          </span>
        )}
      </label>
      <div className="st-field-input">
        <WidgetRenderer {...next} />
      </div>
    </div>
  )
}

function WidgetRenderer(props: WidgetProps): React.ReactElement {
  switch (props.config.widget) {
    case "text":
    case "email":
    case "url":
    case "uuid":
      return <TextWidget {...props} />
    case "slug":
      return <SlugWidget {...props} />
    case "derivedText":
      return <DerivedTextWidget {...props} />
    case "textarea":
      return <TextWidget {...props} multiline />
    case "number":
      return <NumberWidget {...props} />
    case "boolean":
      return <BooleanWidget {...props} />
    case "date":
    case "datetime":
      return <DateWidget {...props} />
    case "select":
      return <SelectWidget {...props} />
    case "image":
      return <ImageWidget {...props} />
    case "file":
      return <FileWidget {...props} />
    case "relation":
    case "multirelation":
      return <RelationWidget {...props} />
    case "richtext":
      return <RichTextWidget {...props} />
    case "json":
      return <JsonWidget {...props} />
    case "blocks":
      return <BlocksWidget {...props} />
    case "publish":
      return <PublishWidget {...props} />
    case "color":
      return <ColorWidget {...props} />
    case "xml":
      return <XmlWidget {...props} />
    case "button":
      return <ButtonWidget {...props} />
    default:
      return <TextWidget {...props} />
  }
}
