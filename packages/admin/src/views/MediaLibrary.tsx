import React, { useState, useEffect, useCallback, useRef } from "react"
import { Header } from "../components/Header.js"
import { useAdminClient } from "../hooks/useAdminClient.js"
import type { StorageObject } from "@supatype/client"

type ViewMode = "grid" | "list"

interface MediaFile extends StorageObject {
  publicUrl?: string
}

export function MediaLibrary(): React.ReactElement {
  const client = useAdminClient()
  const [buckets, setBuckets] = useState<Array<{ id: string; name: string; public: boolean }>>([])
  const [currentBucket, setCurrentBucket] = useState<string | null>(null)
  const [prefix, setPrefix] = useState("")
  const [files, setFiles] = useState<MediaFile[]>([])
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>("grid")
  const [search, setSearch] = useState("")
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Load buckets
  useEffect(() => {
    void (async () => {
      try {
        // Bucket list requires service_role — fallback to known buckets from config
        // For now, fetch from the storage API
        const res = await fetch(`${getStorageUrl(client)}/bucket`, {
          headers: getHeaders(client),
        })
        if (res.ok) {
          setBuckets(await res.json() as Array<{ id: string; name: string; public: boolean }>)
        }
      } catch {
        // Buckets may not be accessible without service_role
      } finally {
        setLoading(false)
      }
    })()
  }, [client])

  // Load files when bucket/prefix changes
  useEffect(() => {
    if (!currentBucket) return
    void (async () => {
      setLoading(true)
      try {
        const result = await client.storage.from(currentBucket).list(prefix || undefined, { limit: 100 })
        if (result.data) {
          const mapped: MediaFile[] = result.data.map((obj) => ({
            ...obj,
            publicUrl: client.storage.from(currentBucket).getPublicUrl(obj.name).data.publicUrl,
          }))
          setFiles(mapped)
        }
      } catch {
        setFiles([])
      } finally {
        setLoading(false)
      }
    })()
  }, [client, currentBucket, prefix])

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
      // Refresh
      setPrefix(prefix) // trigger re-fetch
    } finally {
      setUploading(false)
    }
  }

  const handleDelete = async (fileName: string) => {
    if (!currentBucket) return
    await client.storage.from(currentBucket).remove([fileName])
    setFiles((prev) => prev.filter((f) => f.name !== fileName))
  }

  // Breadcrumb
  const breadcrumbs = prefix
    ? prefix.split("/").filter(Boolean).map((part, i, arr) => ({
        label: part,
        path: arr.slice(0, i + 1).join("/") + "/",
      }))
    : []

  const filteredFiles = search
    ? files.filter((f) => f.name.toLowerCase().includes(search.toLowerCase()))
    : files

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
        {/* Bucket selector */}
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

        {/* Breadcrumb */}
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

        {/* Search */}
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
              <button
                type="button"
                className="st-btn st-btn-sm st-btn-danger"
                onClick={() => { void handleDelete(file.name) }}
              >
                Delete
              </button>
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
                <td>{file.metadata?.["mimetype"] as string ?? "—"}</td>
                <td>{file.updated_at ? new Date(file.updated_at).toLocaleDateString() : "—"}</td>
                <td>
                  <button
                    type="button"
                    className="st-btn st-btn-sm st-btn-danger"
                    onClick={() => { void handleDelete(file.name) }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// Helpers to extract storage URL and headers from the client
function getStorageUrl(client: { storage: { from: (b: string) => { getPublicUrl: (p: string) => { data: { publicUrl: string } } } } }): string {
  // Derive storage URL from a getPublicUrl call
  const test = client.storage.from("__test__").getPublicUrl("__test__").data.publicUrl
  return test.replace("/object/public/__test__/__test__", "")
}

function getHeaders(_client: unknown): Record<string, string> {
  // In a real impl, extract the auth headers from the client
  return { "Content-Type": "application/json" }
}
