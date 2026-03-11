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

export interface WidgetProps {
  config: FieldConfig
  value: unknown
  onChange: (value: unknown) => void
  readOnly: boolean
}

export function FieldWidget(props: WidgetProps): React.ReactElement {
  const { config } = props

  return (
    <div className={`st-field st-field--${config.widget}${config.required ? " st-field--required" : ""}`}>
      <label className="st-field-label" htmlFor={`field-${config.name}`}>
        {config.label}
        {config.required && <span className="st-field-required" aria-label="required"> *</span>}
        {config.localized && <span className="st-field-localized" title="This field is translated"> L</span>}
      </label>
      <div className="st-field-input">
        <WidgetRenderer {...props} />
      </div>
    </div>
  )
}

function WidgetRenderer(props: WidgetProps): React.ReactElement {
  switch (props.config.widget) {
    case "text":
    case "email":
    case "url":
    case "slug":
    case "uuid":
      return <TextWidget {...props} />
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
    default:
      return <TextWidget {...props} />
  }
}
