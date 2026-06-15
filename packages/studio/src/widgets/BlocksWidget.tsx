import React, { useState } from "react"
import type { WidgetProps } from "./FieldWidget.js"
import type { BlockTypeConfig, FieldConfig } from "../config.js"
import { getLocalizedFieldValue, setLocalizedFieldValue } from "../lib/localized-field.js"
import { FieldWidget as FieldWidgetComponent } from "./FieldWidget.js"

interface BlockEntry {
  type: string
  data: Record<string, unknown>
}

function resolveBlockSubFieldValue(
  blockData: Record<string, unknown>,
  fieldConfig: FieldConfig,
  currentLocale: string,
  defaultLocale: string,
): unknown {
  return getLocalizedFieldValue(
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
  const blocksValue = getLocalizedFieldValue(
    value,
    config.localized,
    currentLocale,
    defaultLocale,
  )
  const blocks = (Array.isArray(blocksValue) ? blocksValue : []) as BlockEntry[]
  const blockTypes = (config.options?.["blockTypes"] ?? []) as BlockTypeConfig[]
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
    const copy = JSON.parse(JSON.stringify(blocks[index])) as BlockEntry
    const next = [...blocks]
    next.splice(index + 1, 0, copy)
    commitBlocks(next)
    setExpandedIndex(index + 1)
  }

  return (
    <div className="st-blocks-widget">
      {blocks.map((block, index) => {
        const blockType = blockTypes.find((bt) => bt.name === block.type)
        const isExpanded = expandedIndex === index

        return (
          <div key={`${block.type}-${index}`} className="st-block-card">
            <div
              className="st-block-header"
              onClick={() => { setExpandedIndex(isExpanded ? null : index) }}
            >
              <span className="st-block-type">
                {blockType?.icon && <span className="st-block-icon">{blockType.icon}</span>}
                {blockType?.label ?? block.type}
              </span>
              <div className="st-block-actions" onClick={(e) => { e.stopPropagation() }}>
                {!readOnly && (
                  <>
                    <button
                      type="button"
                      className="st-btn-icon"
                      onClick={() => { moveBlock(index, -1) }}
                      disabled={index === 0}
                      title="Move up"
                    >
                      &uarr;
                    </button>
                    <button
                      type="button"
                      className="st-btn-icon"
                      onClick={() => { moveBlock(index, 1) }}
                      disabled={index === blocks.length - 1}
                      title="Move down"
                    >
                      &darr;
                    </button>
                    <button
                      type="button"
                      className="st-btn-icon"
                      onClick={() => { duplicateBlock(index) }}
                      title="Duplicate"
                    >
                      D
                    </button>
                    <button
                      type="button"
                      className="st-btn-icon st-btn-icon--danger"
                      onClick={() => { removeBlock(index) }}
                      title="Delete"
                    >
                      X
                    </button>
                  </>
                )}
              </div>
            </div>

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
        <div className="st-block-add">
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
                  {bt.icon && <span>{bt.icon} </span>}
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
        </div>
      )}
    </div>
  )
}
