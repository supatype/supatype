import React, { useState } from "react"
import type { WidgetProps } from "./FieldWidget.js"
import type { BlockTypeConfig, FieldConfig } from "../config.js"
import {
  getLocalizedEditValue,
  getLocalizedFallbackPlaceholder,
  setLocalizedFieldValue,
} from "../lib/localized-field.js"
import { isJsonObject } from "../lib/json.js"
import { mapEngineFields } from "../lib/normalize-admin-config.js"
import { FieldWidget as FieldWidgetComponent } from "./FieldWidget.js"
import { Icon, IconArrowDown, IconArrowUp, IconCopy, IconSquare, IconTrash, hasIcon } from "../components/icons.js"
import { Button } from "../components/ui.js"

interface BlockEntry {
  type: string
  data: Record<string, unknown>
  /** Whatever else a stored block carries, kept as it is when the block is edited. */
  [key: string]: unknown
}

/** A stored block, with `type` and `data` read defensively; anything that is not an object is no block. */
function toBlockEntry(raw: unknown): BlockEntry | null {
  if (!isJsonObject(raw)) return null
  const { type, data } = raw
  return { ...raw, type: typeof type === "string" ? type : "", data: isJsonObject(data) ? data : {} }
}

function blockEntriesOf(value: unknown): BlockEntry[] {
  if (!Array.isArray(value)) return []
  return value.map(toBlockEntry).filter((entry): entry is BlockEntry => entry !== null)
}

/** The block types the engine lists under `options.blockTypes`, their fields read like any model's. */
function blockTypesOf(options: Record<string, unknown> | undefined): BlockTypeConfig[] {
  const raw = options?.["blockTypes"]
  if (!Array.isArray(raw)) return []
  return raw.filter(isJsonObject).map((bt) => {
    const name = String(bt["name"] ?? "")
    const icon = bt["icon"]
    return {
      name,
      label: typeof bt["label"] === "string" ? bt["label"] : name,
      ...(typeof icon === "string" && { icon }),
      fields: mapEngineFields(bt["fields"]),
    }
  })
}

function resolveBlockSubFieldValue(
  blockData: Record<string, unknown>,
  fieldConfig: FieldConfig,
  currentLocale: string,
): unknown {
  return getLocalizedEditValue(
    blockData[fieldConfig.name],
    fieldConfig.localized,
    currentLocale,
  )
}

function resolveBlockSubFieldPlaceholder(
  blockData: Record<string, unknown>,
  fieldConfig: FieldConfig,
  currentLocale: string,
  defaultLocale: string,
): string | undefined {
  return getLocalizedFallbackPlaceholder(
    blockData[fieldConfig.name],
    fieldConfig.localized,
    currentLocale,
    defaultLocale,
  )
}

function applyBlockSubFieldChange(
  blockData: Record<string, unknown>,
  fieldConfig: FieldConfig,
  currentLocale: string,
  value: unknown,
): Record<string, unknown> {
  return {
    ...blockData,
    [fieldConfig.name]: setLocalizedFieldValue(
      blockData[fieldConfig.name],
      fieldConfig.localized,
      currentLocale,
      value,
    ),
  }
}

export function BlocksWidget({
  config,
  value,
  onChange,
  readOnly,
  currentLocale = "en",
  defaultLocale = "en",
}: WidgetProps): React.ReactElement {
  const blocksValue = getLocalizedEditValue(
    value,
    config.localized,
    currentLocale,
  )
  const blocks = blockEntriesOf(blocksValue)
  const blockTypes = blockTypesOf(config.options)
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)
  const [showPicker, setShowPicker] = useState(false)

  const commitBlocks = (nextBlocks: BlockEntry[]) => {
    onChange(
      setLocalizedFieldValue(value, config.localized, currentLocale, nextBlocks),
    )
  }

  const addBlock = (typeName: string) => {
    const newBlock: BlockEntry = { type: typeName, data: {} }
    commitBlocks([...blocks, newBlock])
    setExpandedIndex(blocks.length)
    setShowPicker(false)
  }

  const removeBlock = (index: number) => {
    commitBlocks(blocks.filter((_, i) => i !== index))
    if (expandedIndex === index) setExpandedIndex(null)
  }

  const updateBlock = (index: number, fieldName: string, fieldValue: unknown) => {
    const blockType = blockTypes.find((bt) => bt.name === blocks[index]?.type)
    const fieldConfig = blockType?.fields.find((f) => f.name === fieldName)
    commitBlocks(
      blocks.map((block, i) => {
        if (i !== index) return block
        const data = fieldConfig
          ? applyBlockSubFieldChange(block.data, fieldConfig, currentLocale, fieldValue)
          : { ...block.data, [fieldName]: fieldValue }
        return { ...block, data }
      }),
    )
  }

  const moveBlock = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= blocks.length) return
    const next = [...blocks]
    const temp = next[index]!
    next[index] = next[target]!
    next[target] = temp
    commitBlocks(next)
    setExpandedIndex(target)
  }

  const duplicateBlock = (index: number) => {
    const source = blocks[index]
    const copy = source === undefined ? null : toBlockEntry(JSON.parse(JSON.stringify(source)))
    if (copy === null) return
    const next = [...blocks]
    next.splice(index + 1, 0, copy)
    commitBlocks(next)
    setExpandedIndex(index + 1)
  }

  // An item count has no native input attribute to lean on, so the bound has to be visible or the
  // author only learns about it when the save is refused.
  const { minItems, maxItems } = config.validation ?? {}
  const itemBound =
    minItems !== undefined || maxItems !== undefined
      ? [
          minItems !== undefined ? `at least ${minItems}` : null,
          maxItems !== undefined ? `at most ${maxItems}` : null,
        ]
          .filter(Boolean)
          .join(", ")
      : null

  const count =
    itemBound === null ? null : `${blocks.length} block${blocks.length === 1 ? "" : "s"} (${itemBound})`

  return (
    <div className="st-blocks-widget">
      {readOnly && count !== null && <BlockCount text={count} />}
      {blocks.map((block, index) => {
        const blockType = blockTypes.find((bt) => bt.name === block.type)
        const isExpanded = expandedIndex === index

        return (
          <div key={`${block.type}-${index}`} className="st-block-card">
            <BlockHeader
              kind={{ label: blockType?.label ?? block.type, ...(blockType?.icon !== undefined && { icon: blockType.icon }) }}
              position={{ index, count: blocks.length }}
              onToggle={() => { setExpandedIndex(isExpanded ? null : index) }}
              actions={readOnly ? null : {
                move: (direction) => { moveBlock(index, direction) },
                duplicate: () => { duplicateBlock(index) },
                remove: () => { removeBlock(index) },
              }}
            />

            {isExpanded && blockType && (
              <div className="st-block-body">
                {blockType.fields.map((fieldConfig) => (
                  <FieldWidgetComponent
                    key={`${fieldConfig.name}-${currentLocale}`}
                    config={fieldConfig}
                    value={resolveBlockSubFieldValue(
                      block.data,
                      fieldConfig,
                      currentLocale,
                    )}
                    localePlaceholder={resolveBlockSubFieldPlaceholder(
                      block.data,
                      fieldConfig,
                      currentLocale,
                      defaultLocale,
                    )}
                    onChange={(val) => { updateBlock(index, fieldConfig.name, val) }}
                    readOnly={readOnly}
                    currentLocale={currentLocale}
                    defaultLocale={defaultLocale}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}

      {!readOnly && (
        <div className="st-block-add flex items-center justify-between gap-2">
          {showPicker ? (
            <div className="st-block-picker">
              <span className="st-block-picker-label">Add block:</span>
              {blockTypes.map((bt) => (
                <button
                  key={bt.name}
                  type="button"
                  className="st-btn st-btn-sm"
                  onClick={() => { addBlock(bt.name) }}
                >
                  <BlockIcon name={bt.icon} size={14} />
                  {bt.label}
                </button>
              ))}
              <button
                type="button"
                className="st-btn st-btn-sm"
                onClick={() => { setShowPicker(false) }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="st-btn"
              onClick={() => { setShowPicker(true) }}
            >
              + Add block
            </button>
          )}
          {count !== null && <BlockCount text={count} />}
        </div>
      )}
    </div>
  )
}

/**
 * A block type's icon. One the schema names but Studio does not have draws a plain square, never
 * the name as text; a type with no icon draws nothing.
 */
function BlockIcon({ name, size }: { name: string | undefined; size: number }): React.ReactElement | null {
  if (name === undefined) return null
  return hasIcon(name) ? <Icon name={name} size={size} /> : <IconSquare size={size} />
}

/** How many blocks there are against the field's bounds, on its own line rather than floated. */
function BlockCount({ text }: { text: string }): React.ReactElement {
  return <span className="shrink-0 text-[0.7rem] text-muted-foreground">{text}</span>
}

interface BlockActions {
  move: (direction: -1 | 1) => void
  duplicate: () => void
  remove: () => void
}

/** A block's row: its type's icon and label, then icon buttons named for a screen reader. */
function BlockHeader({ kind, position, onToggle, actions }: {
  kind: { label: string; icon?: string }
  position: { index: number; count: number }
  onToggle: () => void
  actions: BlockActions | null
}): React.ReactElement {
  const { label, icon } = kind
  return (
    <div data-block-header className="st-block-header" onClick={onToggle}>
      <span data-block-type className="st-block-type inline-flex items-center gap-2">
        <BlockIcon name={icon} size={16} />
        {label}
      </span>
      {actions !== null && (
        <div className="st-block-actions flex items-center gap-0.5" onClick={(e) => { e.stopPropagation() }}>
          <BlockButton name={`Move ${label} up`} onClick={() => { actions.move(-1) }} disabled={position.index === 0}><IconArrowUp /></BlockButton>
          <BlockButton name={`Move ${label} down`} onClick={() => { actions.move(1) }} disabled={position.index === position.count - 1}><IconArrowDown /></BlockButton>
          <BlockButton name={`Duplicate ${label}`} onClick={actions.duplicate}><IconCopy size={14} /></BlockButton>
          <BlockButton name={`Delete ${label}`} onClick={actions.remove} danger><IconTrash /></BlockButton>
        </div>
      )}
    </div>
  )
}

function BlockButton({ name, children, danger = false, ...props }: {
  name: string
  children: React.ReactNode
  danger?: boolean
} & Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "disabled">): React.ReactElement {
  return (
    <Button type="button" variant="ghost" size="icon" aria-label={name} title={name} {...(danger && { className: "hover:text-destructive-text" })} {...props}>
      {children}
    </Button>
  )
}
