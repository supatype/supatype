import React, { useState, useEffect, useMemo, useRef } from "react"
import { Header } from "../components/Header.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import { listedOfTotal, useStorageList } from "../hooks/useStorageList.js"
import { useDebouncedValue } from "../hooks/useDebouncedValue.js"
import type { StorageListEntry } from "@supatype/client"
import { storagePublicUrl } from "../lib/storage-ref.js"
import { useShowsProjectRows } from "../components/ElevatedModeBanner.js"
import { ConfirmButton } from "../components/ui.js"

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

const SEARCH_DEBOUNCE_MS = 300

export function MediaLibrary(): React.ReactElement {
  // Rows here are read with the service role, so the elevated-access notice applies
  // to this view. See `useShowsProjectRows`.
  useShowsProjectRows()

  const client = useAdminClient()
  const [buckets, setBuckets] = useState<Array<{ id: string; name: string; public: boolean }>>([])
  const [currentBucket, setCurrentBucket] = useState<string | null>(null)
  const [prefix, setPrefix] = useState("")
  const [bucketsLoading, setBucketsLoading] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>("grid")
  const [search, setSearch] = useState("")
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void (async () => {
      try {
        const { data, error } = await client.storage.listBuckets()
        if (!error && data) {
          setBuckets(data.map((b) => ({ id: b.id, name: b.name, public: b.public })))
        }
      } catch {
        // Buckets may not be accessible without service_role
      } finally {
        setBucketsLoading(false)
      }
    })()
  }, [client])

  // A page at a time with more on request: it read a fixed 100 and hid the rest of a bigger folder.
  // Searched by the storage server once typing pauses, so a search covers the whole folder.
  const settledSearch = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS)
  const listing = useStorageList(client, { bucket: currentBucket, prefix, search: settledSearch })
  const files = useMemo((): MediaFile[] => {
    if (currentBucket === null) return []
    return listing.items.map((obj) => ({ ...obj, publicUrl: storagePublicUrl(client, { bucket: currentBucket, path: obj.name }) }))
  }, [client, currentBucket, listing.items])
  const loading = bucketsLoading || (currentBucket !== null && listing.loading)

  const handleUpload = async (fileList: FileList) => {
    if (!currentBucket || fileList.length === 0) return
    setUploading(true)
    try {
      for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i]!
        const path = prefix ? `${prefix}${file.name}` : file.name
        await client.storage.from(currentBucket).upload(path, file, {
          contentType: file.type,
          upsert: true,
        })
      }
      listing.reload()
    } finally {
      setUploading(false)
    }
  }

  const handleDelete = async (fileName: string) => {
    if (!currentBucket) return
    await client.storage.from(currentBucket).remove([fileName])
    listing.reload()
  }

  const breadcrumbs = prefix
    ? prefix.split("/").filter(Boolean).map((part, i, arr) => ({
        label: part,
        path: arr.slice(0, i + 1).join("/") + "/",
      }))
    : []

  const filteredFiles = files

  const isImage = (name: string): boolean => {
    return /\.(jpg|jpeg|png|gif|webp|avif|svg)$/i.test(name)
  }

  return (
    <div className="st-media-library">
      <Header
        title="Media Library"
        actions={
          <div className="st-media-actions">
            <button
              type="button"
              className="st-btn st-btn-sm"
              onClick={() => { setViewMode(viewMode === "grid" ? "list" : "grid") }}
            >
              {viewMode === "grid" ? "List" : "Grid"}
            </button>
            {currentBucket && (
              <button
                type="button"
                className="st-btn st-btn-primary"
                onClick={() => { fileInputRef.current?.click() }}
                disabled={uploading}
              >
                {uploading ? "Uploading..." : "Upload"}
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="st-hidden"
              onChange={(e) => {
                if (e.target.files) void handleUpload(e.target.files)
              }}
            />
          </div>
        }
      />

      <div className="st-media-toolbar">
        <select
          className="st-select"
          value={currentBucket ?? ""}
          onChange={(e) => { setCurrentBucket(e.target.value || null); setPrefix("") }}
        >
          <option value="">Select bucket...</option>
          {buckets.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} {b.public ? "(public)" : "(private)"}
            </option>
          ))}
        </select>

        {currentBucket && (
          <nav className="st-media-breadcrumb" aria-label="Folder path">
            <button type="button" onClick={() => { setPrefix("") }} className="st-breadcrumb-link">
              /
            </button>
            {breadcrumbs.map((crumb) => (
              <span key={crumb.path}>
                {" / "}
                <button
                  type="button"
                  onClick={() => { setPrefix(crumb.path) }}
                  className="st-breadcrumb-link"
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </nav>
        )}

        <input
          type="search"
          className="st-input st-input-sm"
          placeholder="Search files..."
          value={search}
          onChange={(e) => { setSearch(e.target.value) }}
        />
      </div>

      {loading ? (
        <div className="st-media-loading">Loading...</div>
      ) : !currentBucket ? (
        <div className="st-media-empty">Select a bucket to browse files.</div>
      ) : filteredFiles.length === 0 ? (
        <div className="st-media-empty">No files found.</div>
      ) : viewMode === "grid" ? (
        <div className="st-media-grid">
          {filteredFiles.map((file) => (
            <div key={file.name} className="st-media-card">
              {isImage(file.name) && file.publicUrl ? (
                <img src={file.publicUrl} alt={file.name} className="st-media-thumb" />
              ) : (
                <div className="st-media-icon">FILE</div>
              )}
              <div className="st-media-name" title={file.name}>
                {file.name.split("/").pop()}
              </div>
              <DeleteFileButton path={file.name} onDelete={() => { void handleDelete(file.name) }} />
            </div>
          ))}
        </div>
      ) : (
        <table className="st-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredFiles.map((file) => (
              <tr key={file.name}>
                <td>{file.name.split("/").pop()}</td>
                <td>{String(file.metadata?.["mimetype"] ?? "-")}</td>
                <td>{file.updated_at ? new Date(file.updated_at).toLocaleDateString() : "-"}</td>
                <td>
                  <DeleteFileButton path={file.name} onDelete={() => { void handleDelete(file.name) }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!loading && currentBucket ? (
        <div className="st-media-toolbar">
          <span>{listedOfTotal(listing)}</span>
          {listing.more ? (
            <button type="button" className="st-btn st-btn-sm" onClick={listing.loadMore} disabled={listing.loadingMore}>
              Load more
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
