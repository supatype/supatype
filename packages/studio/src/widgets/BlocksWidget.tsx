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
import { Button, Card, DisclosureButton, IconButton } from "../components/ui.js"

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

/** `blocks` with the one at `index` swapped with its neighbour, or null when there is none that way. */
function movedBlocks(blocks: BlockEntry[], index: number, direction: -1 | 1): BlockEntry[] | null {
  const target = index + direction
  if (target < 0 || target >= blocks.length) return null
  const next = [...blocks]
  const temp = next[index]!
  next[index] = next[target]!
  next[target] = temp
  return next
}

/** `blocks` with a deep copy of the one at `index` inserted after it, or null when there is none. */
function duplicatedBlocks(blocks: BlockEntry[], index: number): BlockEntry[] | null {
  const source = blocks[index]
  const copy = source === undefined ? null : toBlockEntry(JSON.parse(JSON.stringify(source)))
  if (copy === null) return null
  const next = [...blocks]
  next.splice(index + 1, 0, copy)
  return next
}

/**
 * "3 blocks (at most 20)". An item count has no native input attribute to lean on, so the bound has
 * to be visible or the author only learns about it when the save is refused. Null with no bound.
 */
function blockCountText(validation: FieldConfig["validation"], count: number): string | null {
  const { minItems, maxItems } = validation ?? {}
  if (minItems === undefined && maxItems === undefined) return null
  const bound = [
    minItems !== undefined ? `at least ${minItems}` : null,
    maxItems !== undefined ? `at most ${maxItems}` : null,
  ].filter(Boolean).join(", ")
  return `${count} block${count === 1 ? "" : "s"} (${bound})`
}

/** The field's blocks in this locale, which one is open, and every edit, each handed to the form. */
interface BlockEditor {
  blocks: BlockEntry[]
  blockTypes: BlockTypeConfig[]
  expandedIndex: number | null
  setExpandedIndex: (index: number | null) => void
  add: (typeName: string) => void
  remove: (index: number) => void
  update: (index: number, fieldName: string, fieldValue: unknown) => void
  move: (index: number, direction: -1 | 1) => void
  duplicate: (index: number) => void
}

/** `block` with `fieldName` set to `fieldValue`, in the editing locale when its type declares the field. */
function withField(block: BlockEntry, field: { name: string; config: FieldConfig | undefined; locale: string }, fieldValue: unknown): BlockEntry {
  const data = field.config
    ? applyBlockSubFieldChange(block.data, field.config, field.locale, fieldValue)
    : { ...block.data, [field.name]: fieldValue }
  return { ...block, data }
}

function useBlockEditor({ config, value, onChange, currentLocale = "en" }: WidgetProps): BlockEditor {
  const blocks = blockEntriesOf(getLocalizedEditValue(value, config.localized, currentLocale))
  const blockTypes = blockTypesOf(config.options)
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)
  const commit = (next: BlockEntry[]): void => { onChange(setLocalizedFieldValue(value, config.localized, currentLocale, next)) }
  /** Commits `next` when there is one, then opens the block at `open`. */
  const commitOpening = (next: BlockEntry[] | null, open: number): void => {
    if (next === null) return
    commit(next)
    setExpandedIndex(open)
  }
  const fieldOf = (index: number, name: string): FieldConfig | undefined =>
    blockTypes.find((bt) => bt.name === blocks[index]?.type)?.fields.find((f) => f.name === name)

  return {
    blocks,
    blockTypes,
    expandedIndex,
    setExpandedIndex,
    add: (typeName) => { commitOpening([...blocks, { type: typeName, data: {} }], blocks.length) },
    remove: (index) => { commit(blocks.filter((_, i) => i !== index)); if (expandedIndex === index) setExpandedIndex(null) },
    update: (index, name, fieldValue) => {
      const field = { name, config: fieldOf(index, name), locale: currentLocale }
      commit(blocks.map((block, i) => (i === index ? withField(block, field, fieldValue) : block)))
    },
    move: (index, direction) => { commitOpening(movedBlocks(blocks, index, direction), index + direction) },
    duplicate: (index) => { commitOpening(duplicatedBlocks(blocks, index), index + 1) },
  }
}

/** The fields of an open block's type, each in the editing locale. */
function BlockFields({ index, editor, field }: {
  index: number
  editor: BlockEditor
  field: Pick<WidgetProps, "readOnly" | "currentLocale" | "defaultLocale">
}): React.ReactElement | null {
  const { readOnly, currentLocale = "en", defaultLocale = "en" } = field
  const block = editor.blocks[index]
  const blockType = editor.blockTypes.find((bt) => bt.name === block?.type)
  if (block === undefined || blockType === undefined) return null
  return (
    <div className="p-3">
      {blockType.fields.map((fieldConfig) => (
        <FieldWidgetComponent
          key={`${fieldConfig.name}-${currentLocale}`}
          config={fieldConfig}
          value={resolveBlockSubFieldValue(block.data, fieldConfig, currentLocale)}
          localePlaceholder={resolveBlockSubFieldPlaceholder(block.data, fieldConfig, currentLocale, defaultLocale)}
          onChange={(val) => { editor.update(index, fieldConfig.name, val) }}
          readOnly={readOnly}
          currentLocale={currentLocale}
          defaultLocale={defaultLocale}
        />
      ))}
    </div>
  )
}

/** One block: its header, and its fields while it is open. */
function BlockCard({ index, editor, field }: {
  index: number
  editor: BlockEditor
  field: Pick<WidgetProps, "readOnly" | "currentLocale" | "defaultLocale">
}): React.ReactElement {
  const block = editor.blocks[index]!
  const blockType = editor.blockTypes.find((bt) => bt.name === block.type)
  const isExpanded = editor.expandedIndex === index
  return (
    <Card className="mb-2 overflow-hidden rounded-lg bg-transparent">
      <BlockHeader
        block={{ label: blockType?.label ?? block.type, ...(blockType?.icon !== undefined && { icon: blockType.icon }), index, count: editor.blocks.length }}
        disclosure={{ open: isExpanded, onToggle: () => { editor.setExpandedIndex(isExpanded ? null : index) } }}
        actions={field.readOnly ? null : {
          move: (direction) => { editor.move(index, direction) },
          duplicate: () => { editor.duplicate(index) },
          remove: () => { editor.remove(index) },
        }}
      />
      {isExpanded && <BlockFields index={index} editor={editor} field={field} />}
    </Card>
  )
}

/** "+ Add block", which opens a button per block type; picking one adds it and closes the choice. */
function AddBlock({ blockTypes, onAdd, count }: { blockTypes: BlockTypeConfig[]; onAdd: (typeName: string) => void; count: string | null }): React.ReactElement {
  const [showPicker, setShowPicker] = useState(false)
  return (
    <div className="mt-2 flex items-center justify-between gap-2">
      {showPicker ? (
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <span className="text-xs text-muted-foreground">Add block:</span>
          {blockTypes.map((bt) => (
            <Button key={bt.name} type="button" onClick={() => { onAdd(bt.name); setShowPicker(false) }}>
              <BlockIcon name={bt.icon} size={14} />
              {bt.label}
            </Button>
          ))}
          <Button type="button" onClick={() => { setShowPicker(false) }}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button type="button" size="md" onClick={() => { setShowPicker(true) }}>
          + Add block
        </Button>
      )}
      {count !== null && <BlockCount text={count} />}
    </div>
  )
}

export function BlocksWidget(props: WidgetProps): React.ReactElement {
  const editor = useBlockEditor(props)
  const count = blockCountText(props.config.validation, editor.blocks.length)
  return (
    <div>
      {props.readOnly && count !== null && <BlockCount text={count} />}
      {editor.blocks.map((block, index) => <BlockCard key={`${block.type}-${index}`} index={index} editor={editor} field={props} />)}
      {!props.readOnly && <AddBlock blockTypes={editor.blockTypes} onAdd={editor.add} count={count} />}
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

/** Which block a header heads: its type's label and icon, and where it sits among the blocks. */
interface BlockPlace {
  label: string
  icon?: string
  index: number
  count: number
}

/**
 * A block's row: a disclosure button naming its type, which opens and closes it from the pointer or
 * the keyboard, then icon buttons for its actions, named for a screen reader.
 */
function BlockHeader({ block, disclosure, actions }: {
  block: BlockPlace
  disclosure: { open: boolean; onToggle: () => void }
  actions: BlockActions | null
}): React.ReactElement {
  const { label, icon } = block
  return (
    <div data-block-header className="flex w-full items-center justify-between bg-secondary pr-3 text-[0.85rem] text-foreground">
      <DisclosureButton open={disclosure.open} className="flex-1 px-3 py-2 font-medium" onClick={disclosure.onToggle}>
        <span data-block-type className="inline-flex items-center gap-2">
          <BlockIcon name={icon} size={16} />
          {label}
        </span>
      </DisclosureButton>
      {actions !== null && (
        <div className="flex items-center gap-0.5">
          <BlockButton name={`Move ${label} up`} onClick={() => { actions.move(-1) }} disabled={block.index === 0}><IconArrowUp /></BlockButton>
          <BlockButton name={`Move ${label} down`} onClick={() => { actions.move(1) }} disabled={block.index === block.count - 1}><IconArrowDown /></BlockButton>
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
    <IconButton label={name} {...(danger && { className: "hover:text-destructive-text" })} {...props}>
      {children}
    </IconButton>
  )
}
