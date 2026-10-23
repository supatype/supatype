import React, { useState, useRef, useEffect } from "react"
import type { StorageListEntry, SupatypeClient } from "@supatype/client"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { listedOfTotal, useStorageList, type StorageListing } from "../hooks/useStorageList.js"
import { useDebouncedValue } from "../hooks/useDebouncedValue.js"
import type { WidgetProps } from "./FieldWidget.js"
import { stringOption } from "./field-options.js"
import {
  parseStorageRef,
  resolveStorageObjectPath,
  storagePublicUrl,
  type StorageRef,
} from "../lib/storage-ref.js"
import {
  getLocalizedEditValue,
  setLocalizedFieldValue,
} from "../lib/localized-field.js"
import { Button, DropZone, FileInput, IconButton, Input, ListButton, Modal, TextLink } from "../components/ui.js"
import { IconFolder, IconX } from "../components/icons.js"
import { cn } from "../lib/utils.js"
import { firstFileOf, useFieldUpload } from "./use-field-upload.js"

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "svg"])

function isImageFileName(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  return IMAGE_EXTS.has(ext)
}

function isFolder(obj: StorageListEntry): boolean {
  return obj.id === null && obj.metadata == null
}

function isImageFile(obj: StorageListEntry): boolean {
  return !isFolder(obj) && isImageFileName(obj.name)
}

// ─── Bucket picker ────────────────────────────────────────────────────────────

/** Where the picker is: the bucket, the folder inside it, and how to move to another folder. */
interface PickerPlace {
  bucket: string
  prefix: string
  setPrefix: (prefix: string) => void
}

const SECTION_LABEL = "mb-1.5 text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground"
const PICKER_NOTE = "py-8 text-center text-sm text-muted-foreground"

/** The bucket, then each folder down to this one, every one a link back up to it. */
function PickerCrumbs({ place }: { place: PickerPlace }): React.ReactElement {
  const parts = place.prefix ? place.prefix.split("/") : []
  return (
    <nav aria-label="Folder path" className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-[0.85rem]">
      <TextLink onClick={() => place.setPrefix("")}>{place.bucket}</TextLink>
      {parts.map((crumb, i) => (
        <React.Fragment key={i}>
          <span className="text-muted-foreground">/</span>
          <TextLink onClick={() => place.setPrefix(parts.slice(0, i + 1).join("/"))}>{crumb}</TextLink>
        </React.Fragment>
      ))}
    </nav>
  )
}

/** The folders in this folder, each opening it. */
function PickerFolders({ folders, place }: { folders: StorageListEntry[]; place: PickerPlace }): React.ReactElement | null {
  if (folders.length === 0) return null
  const open = (name: string): void => place.setPrefix(place.prefix ? `${place.prefix}/${name}` : name)
  return (
    <>
      <div className={SECTION_LABEL}>Folders</div>
      <div className="mb-4 flex flex-col gap-1">
        {folders.map((f) => (
          <ListButton key={f.name} className="border border-border text-foreground" onClick={() => open(f.name)}>
            <IconFolder />
            <span>{f.name}</span>
          </ListButton>
        ))}
      </div>
    </>
  )
}

/** The images in this folder as thumbnails, each picking itself. */
function PickerImages({ images, place, onSelect }: {
  images: StorageListEntry[]
  place: PickerPlace
  onSelect: (ref: StorageRef) => void
}): React.ReactElement | null {
  const client = useAdminClient()
  if (images.length === 0) return null
  return (
    <>
      <div className={SECTION_LABEL}>Images</div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2">
        {images.map((f) => {
          const path = resolveStorageObjectPath(place.prefix, f.name)
          return (
            <ListButton key={f.name} title={f.name} className="flex-col border-2 border-transparent p-1.5 text-center hover:border-primary" onClick={() => onSelect({ bucket: place.bucket, path })}>
              <img src={storagePublicUrl(client, { bucket: place.bucket, path })} alt={f.name} className="h-[90px] w-[90px] rounded border border-border object-cover" />
              <span className="line-clamp-2 max-w-[100px] break-all text-[0.7rem]">{f.name}</span>
            </ListButton>
          )
        })}
      </div>
    </>
  )
}

/** This folder's contents: its folders, its images, and how many other files it holds. */
function PickerContents({ items, place, onSelect }: {
  items: StorageListEntry[]
  place: PickerPlace
  onSelect: (ref: StorageRef) => void
}): React.ReactElement {
  if (items.length === 0) return <div className={PICKER_NOTE}>No files here yet. Upload one to get started.</div>
  const others = items.filter((f) => !isFolder(f) && !isImageFile(f)).length
  return (
    <>
      <PickerFolders folders={items.filter(isFolder)} place={place} />
      <PickerImages images={items.filter(isImageFile)} place={place} onSelect={onSelect} />
      {others > 0 && (
        <div className="mt-2 text-center text-xs text-muted-foreground">
          {others} non-image file{others !== 1 ? "s" : ""} not shown.
        </div>
      )}
    </>
  )
}

/** How many of the folder's files are listed, and Load more while the server holds more. */
function PickerPaging({ listing }: { listing: StorageListing }): React.ReactElement {
  return (
    <div className={cn(SECTION_LABEL, "mt-3 flex items-center gap-2")}>
      {listedOfTotal(listing)}
      {listing.more ? (
        <Button type="button" size="xs" onClick={listing.loadMore} disabled={listing.loadingMore}>
          Load more
        </Button>
      ) : null}
    </div>
  )
}

/** Uploads a file into the folder the picker is in, and picks it once it is there. */
function usePickerUpload(place: PickerPlace, onSelect: (ref: StorageRef) => void): { uploading: boolean; upload: (file: File) => Promise<void> } {
  const client = useAdminClient()
  const [uploading, setUploading] = useState(false)
  const upload = async (file: File): Promise<void> => {
    setUploading(true)
    try {
      const path = resolveStorageObjectPath(place.prefix, `${Date.now()}-${file.name}`)
      const result = await client.storage.from(place.bucket).upload(path, file, { contentType: file.type, upsert: true })
      if (!result.error) onSelect({ bucket: place.bucket, path, mimeType: file.type, size: file.size })
    } finally {
      setUploading(false)
    }
  }
  return { uploading, upload }
}

/** What the picker's caller hears: an image picked, or the picker closed with none. */
interface PickerOutcome {
  onSelect: (ref: StorageRef) => void
  onClose: () => void
}

/** The picker's top row: where it is, Upload new (waiting while the folder loads), and Close. */
function PickerHeader({ place, outcome, loading }: { place: PickerPlace; outcome: PickerOutcome; loading: boolean }): React.ReactElement {
  const fileRef = useRef<HTMLInputElement>(null)
  const { uploading, upload } = usePickerUpload(place, outcome.onSelect)
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
      <PickerCrumbs place={place} />
      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" size="xs" onClick={() => fileRef.current?.click()} disabled={uploading || loading}>
          {uploading ? "Uploading…" : "Upload new"}
        </Button>
        <IconButton label="Close" onClick={outcome.onClose}><IconX /></IconButton>
      </div>
      <FileInput ref={fileRef} accept="image/*" aria-label="Upload new image" onFiles={firstFileOf(upload)} />
    </div>
  )
}

/**
 * Picks an image from the field's bucket, or uploads one into it: a folder at a time, searched by
 * the storage server, a page at a time with more on request. It read a fixed 200 and hid the rest
 * of a bigger folder.
 */
function BucketPickerModal({ bucket, onSelect, onClose }: {
  bucket: string
  onSelect: (ref: StorageRef) => void
  onClose: () => void
}): React.ReactElement {
  const client = useAdminClient()
  const [prefix, setPrefix] = useState("")
  const [search, setSearch] = useState("")
  const settledSearch = useDebouncedValue(search.trim(), 300)
  const listing = useStorageList(client, { bucket, prefix, search: settledSearch })
  const items = listing.items.filter((f) => f.name !== ".emptyFolderPlaceholder")
  const place = { bucket, prefix, setPrefix }

  return (
    <Modal label={`Pick an image from ${bucket}`} onClose={onClose}>
      <PickerHeader place={place} outcome={{ onSelect, onClose }} loading={listing.loading} />
      <div className="shrink-0 px-4 pt-3">
        <Input type="search" className="px-2 py-1 text-xs" aria-label="Search this folder" placeholder="Search this folder..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {listing.loading ? <div className={PICKER_NOTE}>Loading…</div> : <PickerContents items={items} place={place} onSelect={onSelect} />}
        {!listing.loading ? <PickerPaging listing={listing} /> : null}
      </div>
    </Modal>
  )
}

// ─── The field ────────────────────────────────────────────────────────────────

/**
 * Where an image in storage can be shown from: the object downloaded into a blob URL, so a private
 * bucket previews too, or its public URL when the download is refused. Null for no image.
 */
function useStoragePreview(client: SupatypeClient, ref: StorageRef | null): string | null {
  const [blob, setBlob] = useState<string | null>(null)
  const bucket = ref?.bucket
  const path = ref?.path
  useEffect(() => {
    if (bucket === undefined || path === undefined) {
      setBlob(null)
      return
    }
    let blobUrl: string | null = null
    let cancelled = false
    void (async () => {
      const { data, error } = await client.storage.from(bucket).download(path)
      if (cancelled) return
      if (data) {
        blobUrl = URL.createObjectURL(data)
        setBlob(blobUrl)
      } else if (error) {
        setBlob(storagePublicUrl(client, { bucket, path }))
      }
    })()
    return () => {
      cancelled = true
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [client, bucket, path])
  if (bucket === undefined || path === undefined) return null
  return blob ?? storagePublicUrl(client, { bucket, path })
}

const THUMB = "h-[60px] w-[60px] rounded-md border border-border object-cover sm:h-20 sm:w-20"

/** What the image controls do: open the picker, choose a file to upload, and clear the image. */
interface ImageActions {
  pick: () => void
  choose: () => void
  remove: () => void
}

/** This locale's image, with Replace and Remove. */
function ImagePreview({ url, actions, readOnly }: { url: string; actions: ImageActions; readOnly: boolean }): React.ReactElement {
  return (
    <div className="flex items-center gap-3">
      <img src={url} alt="" className={THUMB} />
      {!readOnly && (
        <div className="flex flex-col gap-1.5">
          <Button type="button" size="xs" onClick={actions.pick}>Replace</Button>
          <Button type="button" size="xs" onClick={actions.remove}>Remove</Button>
        </div>
      )}
    </div>
  )
}

/** The default locale's image, faded, shown while this locale has none of its own. */
function FallbackPreview({ url, hint, actions, readOnly }: {
  url: string
  hint: string
  actions: ImageActions
  readOnly: boolean
}): React.ReactElement {
  return (
    <div className="flex items-center gap-3 opacity-85">
      <img src={url} alt="" className={cn(THUMB, "opacity-55")} />
      <div className="flex flex-col gap-2">
        <span className="max-w-56 text-[0.8rem] text-muted-foreground">{hint}</span>
        {!readOnly && (
          <div className="flex flex-col gap-1.5">
            <Button type="button" size="xs" onClick={actions.choose}>Upload for this locale</Button>
            <Button type="button" size="xs" onClick={actions.pick}>Select from bucket</Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** No image yet: drop one here, upload one, or pick one from the bucket. */
function UploadPrompt({ uploading, actions, readOnly }: { uploading: boolean; actions: ImageActions; readOnly: boolean }): React.ReactElement {
  if (uploading) return <span>Uploading…</span>
  return (
    <>
      <span>Drag an image here, or</span>
      <Button type="button" size="xs" onClick={actions.choose} disabled={readOnly}>Upload</Button>
      <Button type="button" size="xs" onClick={actions.pick} disabled={readOnly}>Select from bucket</Button>
    </>
  )
}

/**
 * Dragging an image over the field lights it, and dropping it uploads it. A read-only field takes
 * no drop: it neither lights nor uploads, as its buttons are disabled.
 */
function useImageDrop(readOnly: boolean, upload: (file: File) => Promise<void>): { over: boolean; handlers: React.HTMLAttributes<HTMLDivElement> } {
  const [over, setOver] = useState(false)
  if (readOnly) return { over: false, handlers: {} }
  return {
    over,
    handlers: {
      onDragOver: (e) => { e.preventDefault(); setOver(true) },
      onDragLeave: () => { setOver(false) },
      onDrop: (e) => {
        e.preventDefault()
        setOver(false)
        const file = e.dataTransfer.files[0]
        if (file && file.type.startsWith("image/")) void upload(file)
      },
    },
  }
}

/** The field's value in this locale, the default locale's when this one has none, and how to set it. */
function useLocaleImage(props: WidgetProps, bucket: string): { own: StorageRef | null; fallback: StorageRef | null; commit: (ref: StorageRef | null) => void } {
  const { config, value, onChange, currentLocale = "en", defaultLocale = "en" } = props
  const own = parseStorageRef(getLocalizedEditValue(value, config.localized, currentLocale), bucket)
  const fallbackValue = config.localized && currentLocale !== defaultLocale && !own ? getLocalizedEditValue(value, true, defaultLocale) : null
  return {
    own,
    fallback: parseStorageRef(fallbackValue, bucket),
    commit: (ref) => { onChange(setLocalizedFieldValue(value, config.localized, currentLocale, ref)) },
  }
}

/** What the field shows: this locale's image, else the default locale's, else the drop zone. */
interface ImageView {
  ownUrl: string | null
  fallbackUrl: string | null
  hint: string
  uploading: boolean
  over: boolean
  readOnly: boolean
}

function ImageBody({ view, actions, fileInput }: { view: ImageView; actions: ImageActions; fileInput: React.ReactNode }): React.ReactElement {
  if (view.ownUrl !== null) return <ImagePreview url={view.ownUrl} actions={actions} readOnly={view.readOnly} />
  if (view.fallbackUrl !== null) {
    return (
      <>
        <FallbackPreview url={view.fallbackUrl} hint={view.hint} actions={actions} readOnly={view.readOnly} />
        {fileInput}
      </>
    )
  }
  return (
    <DropZone active={view.over}>
      <UploadPrompt uploading={view.uploading} actions={actions} readOnly={view.readOnly} />
      {fileInput}
    </DropZone>
  )
}

export function ImageWidget(props: WidgetProps): React.ReactElement {
  const { config, readOnly, defaultLocale = "en", localePlaceholder } = props
  const client = useAdminClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const bucket = stringOption(config, "bucket") ?? "images"
  const { own, fallback, commit } = useLocaleImage(props, bucket)
  const ownUrl = useStoragePreview(client, own)
  const fallbackUrl = useStoragePreview(client, fallback)
  const { uploading, upload } = useFieldUpload({ field: config.name, bucket }, commit)
  const drop = useImageDrop(readOnly, upload)
  const actions: ImageActions = { pick: () => { setPickerOpen(true) }, choose: () => { fileRef.current?.click() }, remove: () => { commit(null) } }
  const hint = localePlaceholder ?? `Showing ${defaultLocale} version, upload to override`
  const view = { ownUrl: own ? ownUrl : null, fallbackUrl: fallback ? fallbackUrl : null, hint, uploading, over: drop.over, readOnly }

  return (
    <>
      <div data-drag-over={drop.over || undefined} {...drop.handlers}>
        <ImageBody view={view} actions={actions} fileInput={<FileInput ref={fileRef} accept="image/*" aria-label={`Upload ${config.label}`} onFiles={firstFileOf(upload)} />} />
      </div>
      {pickerOpen && <BucketPickerModal bucket={bucket} onSelect={(ref) => { commit(ref); setPickerOpen(false) }} onClose={() => { setPickerOpen(false) }} />}
    </>
  )
}
