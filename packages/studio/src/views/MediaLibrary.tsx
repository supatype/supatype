import React, { useState, useEffect, useMemo, useRef } from "react"
import { Header } from "../components/Header.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { listedOfTotal, useStorageList, type StorageListing } from "../hooks/useStorageList.js"
import { useDebouncedValue } from "../hooks/useDebouncedValue.js"
import type { StorageListEntry } from "@supatype/client"
import { storagePublicUrl } from "../lib/storage-ref.js"
import { useShowsProjectRows } from "../components/ElevatedModeBanner.js"
import { Button, Card, ConfirmButton, FileInput, Input, Select, TableCard, Td, TextLink, Th, tableRowClass } from "../components/ui.js"
import { useContentWriteOffered } from "../hooks/useContentWriteOffered.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { deleteSelection } from "../lib/storage-delete.js"

type ViewMode = "grid" | "list"

/** Delete on a file, in the grid or the list: the object is removed from the bucket, so it asks first. */
function DeleteFileButton({ path, onDelete }: { path: string; onDelete: () => void }): React.ReactElement {
  const ask = {
    title: `Delete ${path.split("/").pop() ?? path}?`,
    detail: <p>The file is removed from the bucket for good, and any link to it stops working.</p>,
    answer: "Delete file",
  }
  return <ConfirmButton size="xs" variant="destructive" ask={ask} act={onDelete}>Delete</ConfirmButton>
}

type MediaFile = StorageListEntry & {
  publicUrl?: string
}

interface Bucket {
  id: string
  name: string
  public: boolean
}

const SEARCH_DEBOUNCE_MS = 300
const NOTE = "py-8 text-center text-muted-foreground"

const isImage = (name: string): boolean => /\.(jpg|jpeg|png|gif|webp|avif|svg)$/i.test(name)

/** The project's buckets, and whether they are still being read. */
function useBuckets(): { buckets: Bucket[]; loading: boolean } {
  const client = useAdminClient()
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    void (async () => {
      try {
        const { data, error } = await client.storage.listBuckets()
        if (!error && data) setBuckets(data.map((b) => ({ id: b.id, name: b.name, public: b.public })))
      } catch {
        // Buckets may not be accessible without service_role
      } finally {
        setLoading(false)
      }
    })()
  }, [client])
  return { buckets, loading }
}

/** Where the library is: the bucket chosen, the folder in it, and how to change either. */
interface LibraryPlace {
  bucket: string | null
  prefix: string
  setBucket: (bucket: string | null) => void
  setPrefix: (prefix: string) => void
}

/** Uploads every chosen file into the folder being browsed, then reads the folder again. */
function useMediaUpload(place: LibraryPlace, listing: StorageListing): { uploading: boolean; upload: (files: FileList) => Promise<void> } {
  const client = useAdminClient()
  const [uploading, setUploading] = useState(false)
  const upload = async (fileList: FileList): Promise<void> => {
    const { bucket, prefix } = place
    if (!bucket || fileList.length === 0) return
    setUploading(true)
    try {
      for (const file of Array.from(fileList)) {
        const path = prefix ? `${prefix}${file.name}` : file.name
        await client.storage.from(bucket).upload(path, file, { contentType: file.type, upsert: true })
      }
      listing.reload()
    } finally {
      setUploading(false)
    }
  }
  return { uploading, upload }
}

/** List or Grid, and Upload once a bucket is chosen and the viewer may write. */
function LibraryActions({ view, place, listing }: {
  view: { mode: ViewMode; setMode: (mode: ViewMode) => void }
  place: LibraryPlace
  listing: StorageListing
}): React.ReactElement {
  // A viewer browses the library; uploading and deleting are changes.
  const canWrite = useContentWriteOffered()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { uploading, upload } = useMediaUpload(place, listing)
  return (
    <div className="flex items-center gap-2">
      <Button type="button" size="xs" onClick={() => { view.setMode(view.mode === "grid" ? "list" : "grid") }}>
        {view.mode === "grid" ? "List" : "Grid"}
      </Button>
      {place.bucket && canWrite && (
        <Button type="button" variant="primary" onClick={() => { fileInputRef.current?.click() }} disabled={uploading}>
          {uploading ? "Uploading..." : "Upload"}
        </Button>
      )}
      <FileInput ref={fileInputRef} multiple aria-label="Upload files" onFiles={(files) => { void upload(files) }} />
    </div>
  )
}

/** The folder path from the bucket's root, each part a link back up to it. */
function FolderPath({ place }: { place: LibraryPlace }): React.ReactElement {
  const crumbs = place.prefix
    ? place.prefix.split("/").filter(Boolean).map((part, i, arr) => ({ label: part, path: arr.slice(0, i + 1).join("/") + "/" }))
    : []
  return (
    <nav className="flex items-center gap-1 text-[0.8rem]" aria-label="Folder path">
      <TextLink onClick={() => { place.setPrefix("") }}>/</TextLink>
      {crumbs.map((crumb) => (
        <span key={crumb.path}>
          {" / "}
          <TextLink onClick={() => { place.setPrefix(crumb.path) }}>{crumb.label}</TextLink>
        </span>
      ))}
    </nav>
  )
}

/** The bucket menu, the folder path, and the search box. */
function LibraryToolbar({ buckets, place, search }: {
  buckets: Bucket[]
  place: LibraryPlace
  search: { text: string; set: (text: string) => void }
}): React.ReactElement {
  return (
    <div className="mb-4 flex flex-col items-stretch gap-2 md:flex-row md:flex-wrap md:items-center">
      <Select aria-label="Bucket" value={place.bucket ?? ""} onChange={(e) => { place.setBucket(e.target.value || null); place.setPrefix("") }}>
        <option value="">Select bucket...</option>
        {buckets.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name} {b.public ? "(public)" : "(private)"}
          </option>
        ))}
      </Select>
      {place.bucket && <FolderPath place={place} />}
      <Input type="search" aria-label="Search files" className="px-2 py-1 text-xs md:w-auto md:flex-1" placeholder="Search files..." value={search.text} onChange={(e) => { search.set(e.target.value) }} />
    </div>
  )
}

/** What a file's tile or row can do: delete it, offered only to a writer. */
interface FileActions {
  canWrite: boolean
  onDelete: (name: string) => void
}

function FileGrid({ files, actions }: { files: MediaFile[]; actions: FileActions }): React.ReactElement {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(130px,1fr))] sm:gap-4 lg:grid-cols-[repeat(auto-fill,minmax(160px,1fr))]">
      {files.map((file) => (
        <Card key={file.name} className="overflow-hidden">
          {isImage(file.name) && file.publicUrl ? (
            <img src={file.publicUrl} alt={file.name} className="block h-[120px] w-full object-cover" />
          ) : (
            <div className="flex h-[120px] w-full items-center justify-center bg-secondary text-[0.8rem] text-muted-foreground">FILE</div>
          )}
          <div className="truncate px-3 py-2 text-xs" title={file.name}>
            {file.name.split("/").pop()}
          </div>
          {actions.canWrite && <DeleteFileButton path={file.name} onDelete={() => { actions.onDelete(file.name) }} />}
        </Card>
      ))}
    </div>
  )
}

function FileTable({ files, actions }: { files: MediaFile[]; actions: FileActions }): React.ReactElement {
  return (
    <TableCard head={<><Th>Name</Th><Th>Type</Th><Th>Updated</Th><Th>Actions</Th></>}>
      {files.map((file) => (
        <tr key={file.name} className={tableRowClass(false)}>
          <Td>{file.name.split("/").pop()}</Td>
          <Td>{String(file.metadata?.["mimetype"] ?? "-")}</Td>
          <Td>{file.updated_at ? new Date(file.updated_at).toLocaleDateString() : "-"}</Td>
          <Td>{actions.canWrite && <DeleteFileButton path={file.name} onDelete={() => { actions.onDelete(file.name) }} />}</Td>
        </tr>
      ))}
    </TableCard>
  )
}

/** The files, as a grid or a table, or why there are none to show. */
function LibraryFiles({ state, files, actions }: {
  state: { loading: boolean; bucket: string | null; mode: ViewMode }
  files: MediaFile[]
  actions: FileActions
}): React.ReactElement {
  if (state.loading) return <div className={NOTE}>Loading...</div>
  if (!state.bucket) return <div className={NOTE}>Select a bucket to browse files.</div>
  if (files.length === 0) return <div className={NOTE}>No files found.</div>
  return state.mode === "grid" ? <FileGrid files={files} actions={actions} /> : <FileTable files={files} actions={actions} />
}

/** How many of the folder's files are listed, and Load more while the server holds more. */
function LibraryPaging({ listing }: { listing: StorageListing }): React.ReactElement {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <span>{listedOfTotal(listing)}</span>
      {listing.more ? (
        <Button type="button" size="xs" onClick={listing.loadMore} disabled={listing.loadingMore}>
          Load more
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Deletes a file and reads the folder again. A refused delete, or one the server answers without
 * removing the file (its delete rule kept it), is said in words rather than passed over.
 */
function useFileDelete(bucket: string | null, listing: StorageListing): { error: string | null; remove: (name: string) => void } {
  const client = useAdminClient()
  const [error, setError] = useState<string | null>(null)
  const remove = (name: string): void => {
    if (!bucket) return
    setError(null)
    void deleteSelection(client.storage.from(bucket), "", [{ name, isFolder: false }])
      .then(setError, (err: unknown) => { setError(err instanceof Error ? err.message : "The file could not be deleted.") })
      .finally(() => { listing.reload() })
  }
  return { error, remove }
}

/** The folder being browsed, read a page at a time, with each file's public address. */
function useLibraryFiles(place: { bucket: string | null; prefix: string }, search: string): { listing: StorageListing; files: MediaFile[] } {
  const client = useAdminClient()
  const { bucket, prefix } = place
  // A page at a time with more on request: it read a fixed 100 and hid the rest of a bigger folder.
  // Searched by the storage server once typing pauses, so a search covers the whole folder.
  const settledSearch = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS)
  const listing = useStorageList(client, { bucket, prefix, search: settledSearch })
  const files = useMemo((): MediaFile[] => {
    if (bucket === null) return []
    return listing.items.map((obj) => ({ ...obj, publicUrl: storagePublicUrl(client, { bucket, path: obj.name }) }))
  }, [client, bucket, listing.items])
  return { listing, files }
}

export function MediaLibrary(): React.ReactElement {
  // Rows here are read with the service role, so the elevated-access notice applies
  // to this view. See `useShowsProjectRows`.
  useShowsProjectRows()
  const canWrite = useContentWriteOffered()
  const { buckets, loading: bucketsLoading } = useBuckets()
  const [bucket, setBucket] = useState<string | null>(null)
  const [prefix, setPrefix] = useState("")
  const [mode, setMode] = useState<ViewMode>("grid")
  const [search, setSearch] = useState("")
  const place = { bucket, prefix, setBucket, setPrefix }
  const { listing, files } = useLibraryFiles(place, search)
  const deletion = useFileDelete(bucket, listing)
  const loading = bucketsLoading || (bucket !== null && listing.loading)

  return (
    <div>
      <Header title="Media Library" actions={<LibraryActions view={{ mode, setMode }} place={place} listing={listing} />} />
      <LibraryToolbar buckets={buckets} place={place} search={{ text: search, set: setSearch }} />
      {deletion.error !== null && <div className="mb-4"><ErrorBanner message={deletion.error} /></div>}
      <LibraryFiles state={{ loading, bucket, mode }} files={files} actions={{ canWrite, onDelete: deletion.remove }} />
      {!loading && bucket ? <LibraryPaging listing={listing} /> : null}
    </div>
  )
}
