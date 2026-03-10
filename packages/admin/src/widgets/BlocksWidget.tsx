import React, { useState, useCallback } from "react"
import type { WidgetProps } from "./FieldWidget.js"
import type { BlockTypeConfig, FieldConfig } from "../config.js"
import { FieldWidget as FieldWidgetComponent } from "./FieldWidget.js"

interface BlockEntry {
  type: string
  data: Record<string, unknown>
}

export function BlocksWidget({ config, value, onChange, readOnly }: WidgetProps): React.ReactElement {
  const blocks = (Array.isArray(value) ? value : []) as BlockEntry[]
  const blockTypes = (config.options?.["blockTypes"] ?? []) as BlockTypeConfig[]
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)
  const [showPicker, setShowPicker] = useState(false)

  const addBlock = (typeName: string) => {
    const newBlock: BlockEntry = { type: typeName, data: {} }
    onChange([...blocks, newBlock])
    setExpandedIndex(blocks.length)
    setShowPicker(false)
  }

  const removeBlock = (index: number) => {
    const next = blocks.filter((_, i) => i !== index)
    onChange(next)
    if (expandedIndex === index) setExpandedIndex(null)
  }

  const updateBlock = (index: number, fieldName: string, fieldValue: unknown) => {
    const next = blocks.map((block, i) => {
      if (i !== index) return block
      return { ...block, data: { ...block.data, [fieldName]: fieldValue } }
    })
    onChange(next)
  }

  const moveBlock = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= blocks.length) return
    const next = [...blocks]
    const temp = next[index]!
    next[index] = next[target]!
    next[target] = temp
    onChange(next)
    setExpandedIndex(target)
  }

  const duplicateBlock = (index: number) => {
    const copy = JSON.parse(JSON.stringify(blocks[index])) as BlockEntry
    const next = [...blocks]
    next.splice(index + 1, 0, copy)
    onChange(next)
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
                    key={fieldConfig.name}
                    config={fieldConfig}
                    value={block.data[fieldConfig.name] ?? null}
                    onChange={(val) => { updateBlock(index, fieldConfig.name, val) }}
                    readOnly={readOnly}
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
