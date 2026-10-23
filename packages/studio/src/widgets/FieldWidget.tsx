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
import { HasManyWidget, isHasMany } from "./HasManyWidget.js"
import { RichTextWidget } from "./RichTextWidget.js"
import { JsonWidget } from "./JsonWidget.js"
import { BlocksWidget } from "./BlocksWidget.js"
import { PublishWidget } from "./PublishWidget.js"
import { ColorWidget } from "./ColorWidget.js"
import { XmlWidget } from "./XmlWidget.js"
import { CodeWidget } from "./CodeWidget.js"
import { CurrencyWidget } from "./CurrencyWidget.js"
import { SlugWidget } from "./SlugWidget.js"
import { DerivedTextWidget } from "./DerivedTextWidget.js"
import { ButtonWidget } from "./ButtonWidget.js"
import { DurationWidget } from "./DurationWidget.js"
import { GeoPointWidget } from "./GeoPointWidget.js"
import { widgetFor } from "../lib/widget-input.js"
import { WithheldValue } from "../components/WithheldValue.js"
import { IconLanguages } from "../components/icons.js"
import { cn } from "../lib/utils.js"
import { FieldError } from "./field-parts.js"

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
  /**
   * Why this field was refused, shown beneath the input.
   *
   * A validator's refusal names the column it refused, and putting it here rather than in the form's
   * banner is the entire reason a validator is worth declaring over a `beforeChange` hook: a hook
   * speaks for the write, so its message has nowhere better to go.
   */
  error?: string
  /** Default-locale text shown when the active locale has no translation yet. */
  localePlaceholder?: string | undefined
}

/**
 * Engine admin JSON declares `derivedText`; older bundles may still expose `sources`/`template`
 * on `widget: "text"`: route those to DerivedTextWidget so previews track like slug.
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

/** The field's name above it, starred when required and marked when translated. */
function FieldLabel({ config, meta }: { config: FieldConfig; meta: boolean }): React.ReactElement {
  return (
    <label
      htmlFor={`field-${config.name}`}
      className={cn("mb-1 block", meta ? "text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground" : "text-[0.8rem] font-semibold text-foreground")}
    >
      {config.label}
      {config.required && <span className="text-destructive-text" aria-label="required"> *</span>}
      {config.localized && (
        <span className="ml-1 inline-flex align-middle text-primary" title="This field is translated" aria-label="Translated field">
          <IconLanguages />
        </span>
      )}
    </label>
  )
}

/**
 * One field of a record: its label, its editor, and why it was refused when it was. A refused
 * field's input wears the red border its own `aria-invalid` would give it.
 */
export function FieldWidget(props: WidgetProps): React.ReactElement {
  const derived = normalizeDerivedPreviewFieldConfig(props.config)
  const config = { ...derived, widget: widgetFor(derived, props.value) }
  const meta = (props.variant ?? "default") === "meta"
  const invalid = props.error !== undefined

  return (
    <div className={cn(invalid && "[&_[data-ui=input]]:border-destructive [&_[data-ui=textarea]]:border-destructive")}>
      <FieldLabel config={config} meta={meta} />
      <div className={meta ? "mb-3" : "mb-4"}>
        {config.withheld === true || config.withheld === "unknown"
          ? <WithheldValue access={config.withheld === "unknown" ? "unknown" : "hidden"} />
          : <WidgetRenderer {...props} config={config} />}
      </div>
      {invalid && <FieldError id={`field-${config.name}-error`}>{props.error}</FieldError>}
    </div>
  )
}

/** A long text field: the text widget, multi-line. */
const TextareaWidget = (props: WidgetProps): React.ReactElement => <TextWidget {...props} multiline />

/** A many-relation: the rows that point back for a has-many, otherwise the picker. */
const ManyRelationWidget = (props: WidgetProps): React.ReactElement =>
  isHasMany(props.config) ? <HasManyWidget {...props} /> : <RelationWidget {...props} />

/** The editor for each widget name; a name not listed is edited as text. */
const WIDGETS: Readonly<Record<string, (props: WidgetProps) => React.ReactElement>> = {
  text: TextWidget,
  email: TextWidget,
  url: TextWidget,
  uuid: TextWidget,
  slug: SlugWidget,
  derivedText: DerivedTextWidget,
  textarea: TextareaWidget,
  number: NumberWidget,
  boolean: BooleanWidget,
  date: DateWidget,
  datetime: DateWidget,
  select: SelectWidget,
  image: ImageWidget,
  file: FileWidget,
  relation: RelationWidget,
  multirelation: ManyRelationWidget,
  richtext: RichTextWidget,
  json: JsonWidget,
  blocks: BlocksWidget,
  publish: PublishWidget,
  color: ColorWidget,
  xml: XmlWidget,
  code: CodeWidget,
  currency: CurrencyWidget,
  button: ButtonWidget,
  duration: DurationWidget,
  geopoint: GeoPointWidget,
}

function WidgetRenderer(props: WidgetProps): React.ReactElement {
  const name = props.config.widget
  // Own keys only: a name such as `toString` is not a widget, and reads as text like any other.
  const Widget = (Object.hasOwn(WIDGETS, name) ? WIDGETS[name] : undefined) ?? TextWidget
  return <Widget {...props} />
}
