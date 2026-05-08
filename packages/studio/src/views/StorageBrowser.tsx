import React, { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { useStudioClient } from "../StudioCore.js"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { cn } from "../lib/utils.js"
import { Button, Card, Input, Select, Th, Td } from "../components/ui.js"

// ─── Types ────────────────────────────────────────────────────────────────────

interface StorageFile {
  id: string
  name: string
  size: number
  type: string
  updated_at: string
  created_at: string
  is_folder: boolean
  owner_id: string | null
  public_url: string | null
}

interface Bucket {
  id: string
  name: string
  public: boolean
  file_size_limit: number | null
  allowed_mime_types: string[] | null
  created_at: string
  updated_at: string
}

interface UploadProgress {
  fileName: string
  progress: number
  error: string | null
  done: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "\u2014"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

function decodeStorageName(name: string): string {
  return name
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    .join("/")
}

function fileIconText(file: StorageFile): string {
  if (file.is_folder) return "folder"
  if (file.type.startsWith("image/")) return "image"
  if (file.type === "application/pdf") return "pdf"
  if (file.type.startsWith("video/")) return "video"
  if (file.type.startsWith("audio/")) return "audio"
  return "file"
}

function isPreviewable(type: string): boolean {
  return type.startsWith("image/") || type === "application/pdf"
}

function normalizeStoragePublicUrl(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  rawUrl: string,
): string {
  if (!rawUrl) return rawUrl
  try {
    const parsed = new URL(rawUrl)
    const apiOrigin = typeof client?.url === "string" ? new URL(client.url).origin : null
    if (apiOrigin && parsed.origin !== apiOrigin && parsed.pathname.startsWith("/storage/v1/")) {
      return `${apiOrigin}${parsed.pathname}${parsed.search}`
    }
    return rawUrl
  } catch {
    return rawUrl
  }
}

function storageObjectPath(prefix: string[], name: string): string {
  const pathStr = prefix.join("/")
  return pathStr ? `${pathStr}/${name}` : name
}

/** Thumbnail for storage image files (public URL or short-lived signed URL for private buckets). */
function StorageImageThumbnail({
  bucketName,
  bucketPublic,
  pathPrefix,
  fileName,
  alt,
  client,
  sizeClassName,
}: {
  bucketName: string
  bucketPublic: boolean
  pathPrefix: string[]
  fileName: string
  alt: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any
  sizeClassName: string
}): React.ReactElement {
  const filePath = useMemo(() => storageObjectPath(pathPrefix, fileName), [pathPrefix, fileName])

  const publicUrl = useMemo(() => {
    if (!bucketPublic) return null
    const raw = client.storage.from(bucketName).getPublicUrl(filePath).data.publicUrl as string
    return normalizeStoragePublicUrl(client, raw)
  }, [bucketPublic, bucketName, filePath, client])

  const [signedUrl, setSignedUrl] = useState<string | null>(null)

  useEffect(() => {
    if (bucketPublic) {
      setSignedUrl(null)
      return
    }
    let cancelled = false
    void (async () => {
      const { data, error } = await client.storage.from(bucketName).createSignedUrl(filePath, 3600)
      if (cancelled || error || !data?.signedUrl) return
      setSignedUrl(normalizeStoragePublicUrl(client, data.signedUrl))
    })()
    return () => { cancelled = true }
  }, [bucketPublic, bucketName, filePath, client])

  const src = publicUrl ?? signedUrl
  const [broken, setBroken] = useState(false)

  if (broken || !src) {
    return (
      <div className={cn("bg-accent rounded flex shrink-0 items-center justify-center", sizeClassName)}>
        <span className="text-[0.65rem] text-muted-foreground">IMG</span>
      </div>
    )
  }

  return (
    <img
      src={src}
      alt={alt}
      className={cn("rounded object-cover bg-border/50 shrink-0", sizeClassName)}
      loading="lazy"
      onError={() => { setBroken(true) }}
    />
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapStorageFiles(data: any[]): StorageFile[] {
  return (data ?? [])
    .filter((item: any) => item.name !== ".emptyFolderPlaceholder")
    .map((item: any) => ({
      id: item.id ?? `folder-${item.name}`,
      name: item.name as string,
      size: (item.metadata?.size as number) ?? 0,
      type: (item.metadata?.mimetype as string) ?? (item.id === null ? "folder" : "application/octet-stream"),
      updated_at: (item.updated_at as string) ?? new Date().toISOString(),
      created_at: (item.created_at as string) ?? new Date().toISOString(),
      is_folder: item.id === null && item.metadata === null,
      owner_id: (item.owner as string) ?? null,
      public_url: null,
    }))
}

// ─── File Preview Panel ───────────────────────────────────────────────────────

function FilePreview({
  file,
  bucket,
  client,
  currentPath,
}: {
  file: StorageFile
  bucket: Bucket
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any
  currentPath: string[]
}): React.ReactElement {
  const [signedUrl, setSignedUrl] = useState<string | null>(null)
  const [signedUrlError, setSignedUrlError] = useState<string | null>(null)

  const filePath = storageObjectPath(currentPath, file.name)

  const publicUrl = useMemo(() => {
    if (!bucket.public || file.is_folder) return null
    return normalizeStoragePublicUrl(
      client,
      client.storage.from(bucket.name).getPublicUrl(filePath).data.publicUrl as string,
    )
  }, [bucket, file, filePath, client])
  const previewUrl = publicUrl ?? signedUrl

  const generateSignedUrl = async () => {
    setSignedUrlError(null)
    const { data, error } = await client.storage.from(bucket.name).createSignedUrl(filePath, 3600)
    if (error) { setSignedUrlError(error.message); return }
    setSignedUrl(data.signedUrl)
  }

  return (
    <div>
      {file.type.startsWith("image/") ? (
        <div className="bg-accent/30 rounded-md p-4 flex items-center justify-center mb-3">
          {previewUrl ? (
            <img
              src={previewUrl}
              alt={file.name}
              className="w-full max-w-[300px] aspect-video object-contain bg-border/50 rounded"
            />
          ) : (
            <div className="w-full max-w-[300px] aspect-video bg-border/50 rounded flex items-center justify-center text-muted-foreground text-sm">
              Preview unavailable
            </div>
          )}
        </div>
      ) : file.type === "application/pdf" ? (
        <div className="bg-accent/30 rounded-md p-4 flex items-center justify-center mb-3 min-h-[200px]">
          <span className="text-muted-foreground text-sm">PDF preview: {decodeStorageName(file.name)}</span>
        </div>
      ) : (
        <div className="bg-accent/30 rounded-md p-4 flex items-center justify-center mb-3">
          <span className="text-muted-foreground text-sm">No preview available for {file.type}</span>
        </div>
      )}

      {/* File details */}
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase">Name</label>
          <span className="break-all">{decodeStorageName(file.name)}</span>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase">Size</label>
          <span>{formatBytes(file.size)}</span>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase">Type</label>
          <span>{file.type}</span>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase">Owner</label>
          <span>{file.owner_id ?? "none"}</span>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase">Created</label>
          <span className="text-xs">{new Date(file.created_at).toLocaleString()}</span>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase">Modified</label>
          <span className="text-xs">{new Date(file.updated_at).toLocaleString()}</span>
        </div>
      </div>

      {/* Public URL */}
      {publicUrl ? (
        <div className="mt-3">
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-1">Public URL</label>
          <Input value={publicUrl} readOnly className="font-mono text-xs" />
        </div>
      ) : null}

      {/* Signed URL generator (for private buckets) */}
      {!bucket.public ? (
        <div className="mt-3">
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-1">Pre-signed URL</label>
          {signedUrl ? (
            <Input value={signedUrl} readOnly className="font-mono text-xs" />
          ) : (
            <>
              <Button size="xs" onClick={() => void generateSignedUrl()}>Generate Signed URL (1h)</Button>
              {signedUrlError ? <p className="text-xs text-destructive mt-1">{signedUrlError}</p> : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

// ─── Create Bucket Dialog ─────────────────────────────────────────────────────

function CreateBucketDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: (name: string, isPublic: boolean) => void
  onCancel: () => void
}): React.ReactElement {
  const [name, setName] = useState("")
  const [isPublic, setIsPublic] = useState(false)
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <Card className="p-6 max-w-[400px] w-full">
        <h3 className="m-0 mb-3">New Bucket</h3>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Bucket name..."
          autoFocus
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onConfirm(name.trim(), isPublic) }}
        />
        <label className="flex items-center gap-2 mt-3 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
          />
          Public bucket (files accessible without authentication)
        </label>
        <div className="flex gap-2 justify-end mt-4">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={() => { if (name.trim()) onConfirm(name.trim(), isPublic) }}>Create</Button>
        </div>
      </Card>
    </div>
  )
}

// ─── Create Folder Dialog ─────────────────────────────────────────────────────

function CreateFolderDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: (name: string) => void
  onCancel: () => void
}): React.ReactElement {
  const [name, setName] = useState("")
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <Card className="p-6 max-w-[400px] w-full">
        <h3 className="m-0 mb-3">Create Folder</h3>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Folder name..."
          autoFocus
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onConfirm(name.trim()) }}
        />
        <div className="flex gap-2 justify-end mt-4">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={() => { if (name.trim()) onConfirm(name.trim()) }}>Create</Button>
        </div>
      </Card>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function StorageBrowser(): React.ReactElement {
  const client = useStudioClient()
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams<{ bucket?: string }>()
  const [searchParams, setSearchParams] = useSearchParams()

  const syncStorageUrl = useCallback((bucketName: string, segments: string[]) => {
    const query = new URLSearchParams()
    if (segments.length > 0) query.set("prefix", segments.join("/"))
    const qs = query.toString()
    navigate(`/media-storage/${encodeURIComponent(bucketName)}/files${qs ? `?${qs}` : ""}`)
  }, [navigate])

  // Bucket state
  const { data: buckets, loading: bucketsLoading, error: bucketsError, refetch: refetchBuckets } = useApiQuery(
    async () => {
      const { data, error } = await client.storage.listBuckets()
      if (error) throw new Error(error.message)
      return data as Bucket[]
    },
    [],
  )
  const [selectedBucket, setSelectedBucket] = useState("")
  const [path, setPath] = useState<string[]>([])

  // Hydrate from URL and keep folder depth in sync with the history stack (browser back/forward).
  useEffect(() => {
    if (!buckets || buckets.length === 0) return
    const urlBucket = params.bucket ? decodeURIComponent(params.bucket) : null
    const pref = searchParams.get("prefix") ?? ""
    const segments = pref.split("/").filter(Boolean)

    if (urlBucket && buckets.some((b) => b.name === urlBucket)) {
      setSelectedBucket(urlBucket)
      setPath(segments)
      return
    }

    setSelectedBucket((prev) => (prev !== "" ? prev : (buckets[0]?.name ?? "")))
    setPath([])
    const fallback = buckets[0]?.name ?? ""
    if (fallback) {
      syncStorageUrl(fallback, [])
    }
  }, [buckets, params.bucket, searchParams, syncStorageUrl])

  // Files state
  const [files, setFiles] = useState<StorageFile[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [filesError, setFilesError] = useState<string | null>(null)

  const fetchFiles = useCallback(async () => {
    if (!selectedBucket) return
    setFilesLoading(true)
    setFilesError(null)
    try {
      const pathStr = path.join("/")
      const { data, error } = await client.storage.from(selectedBucket).list(pathStr || undefined)
      if (error) throw new Error(error.message)
      setFiles(mapStorageFiles(data ?? []))
    } catch (err: unknown) {
      setFilesError(err instanceof Error ? err.message : String(err))
    } finally {
      setFilesLoading(false)
    }
  }, [selectedBucket, path, client])

  useEffect(() => { void fetchFiles() }, [fetchFiles])

  // View mode
  const [viewMode, setViewMode] = useState<"list" | "grid">("list")

  // Search
  const [search, setSearch] = useState("")

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<StorageFile | null>(null)

  // Upload
  const [uploads, setUploads] = useState<UploadProgress[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Dialogs
  const [showCreateBucket, setShowCreateBucket] = useState(false)
  const [showCreateBucketWarning, setShowCreateBucketWarning] = useState(false)
  const [showCreateFolder, setShowCreateFolder] = useState(false)
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string> | null>(null)

  useEffect(() => {
    const navState = location.state as { openCreateBucket?: boolean } | null
    if (!navState?.openCreateBucket) return
    setShowCreateBucketWarning(true)
    navigate(`${location.pathname}${location.search}`, { replace: true, state: {} })
  }, [location.pathname, location.search, location.state, navigate])

  const handleCreateBucket = async (name: string, isPublic: boolean) => {
    const { error } = await client.storage.createBucket(name, { public: isPublic })
    if (error) {
      setFilesError(error.message)
      return
    }
    setShowCreateBucket(false)
    await refetchBuckets()
    setSelectedBucket(name)
    setPath([])
    syncStorageUrl(name, [])
  }

  const currentBucket = (buckets ?? []).find((b) => b.name === selectedBucket)
  const breadcrumb = selectedBucket ? [selectedBucket, ...path] : []

  // Filtered files
  const filteredFiles = useMemo(() => {
    let result = files
    if (search) {
      const needle = search.toLowerCase()
      result = result.filter((f) => {
        const raw = f.name.toLowerCase()
        const decoded = decodeStorageName(f.name).toLowerCase()
        return raw.includes(needle) || decoded.includes(needle)
      })
    }
    return result
  }, [files, search])

  // Navigation
  const navigateToFolder = (folderName: string) => {
    const newPath = [...path, folderName]
    setPath(newPath)
    setSelectedFile(null)
    setSelectedIds(new Set())
    if (selectedBucket) syncStorageUrl(selectedBucket, newPath)
  }

  const navigateUp = () => {
    const newPath = path.slice(0, -1)
    setPath(newPath)
    setSelectedFile(null)
    setSelectedIds(new Set())
    if (selectedBucket) syncStorageUrl(selectedBucket, newPath)
  }

  const navigateToBreadcrumb = (index: number) => {
    const newPath = index === 0 ? [] : path.slice(0, index)
    setPath(newPath)
    setSelectedFile(null)
    setSelectedIds(new Set())
    if (selectedBucket) syncStorageUrl(selectedBucket, newPath)
  }

  // Upload handling
  const handleUpload = () => {
    fileInputRef.current?.click()
  }

  const handleFileSelect = async (fileList: FileList) => {
    const newUploads: UploadProgress[] = Array.from(fileList).map((f) => ({
      fileName: f.name,
      progress: 0,
      error: null,
      done: false,
    }))
    setUploads((prev) => [...prev, ...newUploads])

    for (let i = 0; i < newUploads.length; i++) {
      const file = fileList[i]!
      const filePath = [...path, file.name].join("/")
      setUploads((prev) => prev.map((u) =>
        u.fileName === file.name ? { ...u, progress: 50 } : u
      ))
      const { error } = await client.storage.from(selectedBucket).upload(filePath, file)
      if (error) {
        setUploads((prev) => prev.map((u) =>
          u.fileName === file.name ? { ...u, error: error.message, progress: 100, done: true } : u
        ))
      } else {
        setUploads((prev) => prev.map((u) =>
          u.fileName === file.name ? { ...u, done: true, progress: 100 } : u
        ))
      }
    }

    void fetchFiles()
    setTimeout(() => {
      setUploads((prev) => prev.filter((u) => !u.done))
    }, 2000)
  }

  // Drag and drop
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }

  const handleDragLeave = () => {
    setIsDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      void handleFileSelect(e.dataTransfer.files)
    }
  }

  // File operations
  const requestDelete = (ids: Set<string>) => {
    setPendingDeleteIds(ids)
  }

  const handleDelete = async () => {
    if (!pendingDeleteIds) return
    const toDelete = files.filter((f) => pendingDeleteIds.has(f.id))
    const pathStr = path.join("/")
    const filePaths = toDelete.map((f) => pathStr ? `${pathStr}/${f.name}` : f.name)
    const { error } = await client.storage.from(selectedBucket).remove(filePaths)
    if (error) {
      setFilesError(error.message)
      setPendingDeleteIds(null)
      return
    }
    setSelectedIds(new Set())
    setSelectedFile(null)
    setPendingDeleteIds(null)
    void fetchFiles()
  }

  const handleCreateFolder = async (name: string) => {
    const filePath = [...path, name, ".emptyFolderPlaceholder"].join("/")
    const { error } = await client.storage.from(selectedBucket).upload(filePath, new Blob([""]))
    if (error) {
      setFilesError(error.message)
      return
    }
    setShowCreateFolder(false)
    void fetchFiles()
  }

  const getFilePath = useCallback((file: StorageFile): string => {
    return storageObjectPath(path, file.name)
  }, [path])

  const handleDownload = useCallback(async (file: StorageFile) => {
    if (!selectedBucket || file.is_folder) return
    const filePath = getFilePath(file)
    let url: string | null = null
    if (currentBucket?.public) {
      url = normalizeStoragePublicUrl(
        client,
        client.storage.from(selectedBucket).getPublicUrl(filePath).data.publicUrl as string,
      )
    } else {
      const { data, error } = await client.storage.from(selectedBucket).createSignedUrl(filePath, 60)
      if (error) {
        setFilesError(error.message)
        return
      }
      url = data?.signedUrl ?? null
    }
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer")
    }
  }, [client, currentBucket?.public, getFilePath, selectedBucket])

  // Bulk selection
  const toggleSelectAll = () => {
    if (selectedIds.size === filteredFiles.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredFiles.map((f) => f.id)))
    }
  }

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <>
      {/* Upload progress bar */}
      {uploads.length > 0 ? (
        <div className="mb-3">
          {uploads.map((u) => (
            <div key={u.fileName} className="flex items-center gap-2 mb-1">
              <span className="text-xs text-muted-foreground truncate max-w-[200px]">{u.fileName}</span>
              <div className="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
                <div
                  className={cn("h-full rounded-full transition-all", u.error ? "bg-red-400" : "bg-primary")}
                  style={{ width: `${u.progress}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground">{u.progress}%</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Input
          className="w-[250px]"
          placeholder="Search files..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="flex-1" />

        <Button
          variant={viewMode === "list" ? "primary" : "secondary"}
          size="sm"
          onClick={() => setViewMode("list")}
        >
          List
        </Button>
        <Button
          variant={viewMode === "grid" ? "primary" : "secondary"}
          size="sm"
          onClick={() => setViewMode("grid")}
        >
          Grid
        </Button>

        {selectedIds.size > 0 ? (
          <Button variant="destructive" size="sm" onClick={() => requestDelete(selectedIds)}>
            Delete {selectedIds.size} selected
          </Button>
        ) : null}

        <Button size="sm" onClick={() => setShowCreateFolder(true)}>New Folder</Button>
        <Button variant="primary" size="sm" onClick={handleUpload}>Upload Files</Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files) void handleFileSelect(e.target.files) }}
        />
      </div>

      <div className="h-full">
        {/* File browser */}
        <div
          className={cn("flex-1 min-w-0", isDragOver && "ring-2 ring-primary ring-offset-2 rounded-lg")}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* Breadcrumb */}
          <div className="flex gap-1 items-center mb-4 text-xs">
            {breadcrumb.map((segment, i) => (
              <React.Fragment key={i}>
                {i > 0 ? <span className="text-zinc-600">/</span> : null}
                <Button
                  variant="secondary"
                  size="xs"
                  className="px-2 py-0.5"
                  onClick={() => navigateToBreadcrumb(i)}
                >
                  {segment}
                </Button>
              </React.Fragment>
            ))}
          </div>

          {filesError && selectedBucket ? (
            <div className="mb-3">
              <ErrorBanner message={filesError} onRetry={fetchFiles} />
            </div>
          ) : null}

          {bucketsLoading ? (
            <div className="flex items-center justify-center py-12">
              <span className="text-sm text-muted-foreground">Loading buckets…</span>
            </div>
          ) : bucketsError ? (
            <ErrorBanner message={bucketsError} onRetry={refetchBuckets} />
          ) : !buckets || buckets.length === 0 ? (
            <EmptyState
              title="No buckets yet"
              description="Create your first storage bucket to start uploading files."
              action={() => setShowCreateBucketWarning(true)}
              actionLabel="Create Bucket"
            />
          ) : !selectedBucket ? (
            <EmptyState
              title="No bucket selected"
              description="Select a bucket from the secondary navigation."
              action={() => setShowCreateBucketWarning(true)}
              actionLabel="Create Bucket"
            />
          ) : filesLoading ? (
            <div className="flex items-center justify-center py-12">
              <span className="text-sm text-muted-foreground">Loading files…</span>
            </div>
          ) : isDragOver ? (
            <div className="border-2 border-dashed border-primary rounded-lg p-12 text-center">
              <p className="text-primary text-sm font-medium">Drop files here to upload</p>
              <p className="text-xs text-muted-foreground mt-1">Files will be uploaded to {breadcrumb.join("/")}</p>
            </div>
          ) : viewMode === "list" ? (
            /* List view */
            <Card className="overflow-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <Th className="w-8">
                      <input
                        type="checkbox"
                        checked={selectedIds.size === filteredFiles.length && filteredFiles.length > 0}
                        onChange={toggleSelectAll}
                      />
                    </Th>
                    <Th>Name</Th>
                    <Th>Size</Th>
                    <Th>Type</Th>
                    <Th>Owner</Th>
                    <Th>Modified</Th>
                    <Th>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {path.length > 0 ? (
                    <tr className="border-b border-border hover:bg-accent/50">
                      <Td />
                      <Td>
                        <button className="text-sm text-muted-foreground hover:text-foreground" onClick={navigateUp}>
                          ..
                        </button>
                      </Td>
                      <td colSpan={5} />
                    </tr>
                  ) : null}
                  {filteredFiles.map((f) => (
                    <tr
                      key={f.id}
                      className={cn(
                        "border-b border-border hover:bg-accent/50",
                        selectedIds.has(f.id) && "bg-primary/5"
                      )}
                    >
                      <Td>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(f.id)}
                          onChange={() => toggleSelect(f.id)}
                        />
                      </Td>
                      <Td>
                        {f.is_folder ? (
                          <button
                            className="font-medium text-primary hover:underline flex items-center gap-1.5"
                            onClick={() => navigateToFolder(f.name)}
                          >
                            <span className="text-muted-foreground">[dir]</span> {decodeStorageName(f.name)}
                          </button>
                        ) : (
                          <button
                            className="hover:text-primary flex items-center gap-2 text-left min-w-0"
                            onClick={() => setSelectedFile(f)}
                          >
                            {f.type.startsWith("image/") && currentBucket ? (
                              <StorageImageThumbnail
                                bucketName={selectedBucket}
                                bucketPublic={currentBucket.public}
                                pathPrefix={path}
                                fileName={f.name}
                                alt={f.name}
                                client={client}
                                sizeClassName="h-9 w-9"
                              />
                            ) : (
                              <span className="text-muted-foreground text-xs shrink-0">[{fileIconText(f)}]</span>
                            )}
                            <span className="truncate">{decodeStorageName(f.name)}</span>
                          </button>
                        )}
                      </Td>
                      <Td className="text-xs text-muted-foreground">{formatBytes(f.size)}</Td>
                      <Td className="text-xs text-muted-foreground">{f.is_folder ? "\u2014" : f.type}</Td>
                      <Td className="text-xs text-muted-foreground">{f.owner_id ?? "\u2014"}</Td>
                      <Td className="text-xs text-muted-foreground">{new Date(f.updated_at).toLocaleDateString()}</Td>
                      <Td>
                        {!f.is_folder ? (
                          <div className="flex gap-1">
                            <Button size="xs" onClick={() => setSelectedFile(f)}>Details</Button>
                            <Button size="xs" onClick={() => { void handleDownload(f) }}>Download</Button>
                            <Button size="xs" variant="destructive" onClick={() => requestDelete(new Set([f.id]))}>
                              Delete
                            </Button>
                          </div>
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                  {filteredFiles.length === 0 && path.length === 0 ? (
                    <tr>
                      <td colSpan={7}>
                        <EmptyState
                          title="This bucket is empty"
                          description="Upload files or drag and drop to get started."
                          action={handleUpload}
                          actionLabel="Upload Files"
                        />
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </Card>
          ) : (
            /* Grid view */
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {path.length > 0 ? (
                <Card
                  className="p-3 cursor-pointer hover:bg-accent/50 flex flex-col items-center justify-center min-h-[120px]"
                  onClick={navigateUp}
                >
                  <span className="text-2xl text-muted-foreground">..</span>
                  <span className="text-xs text-muted-foreground mt-1">Back</span>
                </Card>
              ) : null}
              {filteredFiles.map((f) => (
                <Card
                  key={f.id}
                  className={cn(
                    "p-3 cursor-pointer hover:bg-accent/50 flex flex-col items-center justify-center min-h-[120px] relative",
                    selectedIds.has(f.id) && "ring-2 ring-primary"
                  )}
                  onClick={() => f.is_folder ? navigateToFolder(f.name) : setSelectedFile(f)}
                >
                  <input
                    type="checkbox"
                    className="absolute top-2 left-2"
                    checked={selectedIds.has(f.id)}
                    onChange={(e) => { e.stopPropagation(); toggleSelect(f.id) }}
                    onClick={(e) => e.stopPropagation()}
                  />
                  {f.is_folder ? (
                    <div className="text-3xl text-muted-foreground mb-1">[dir]</div>
                  ) : f.type.startsWith("image/") && currentBucket ? (
                    <div className="mb-1 h-20 w-full max-w-[120px] flex items-center justify-center">
                      <StorageImageThumbnail
                        bucketName={selectedBucket}
                        bucketPublic={currentBucket.public}
                        pathPrefix={path}
                        fileName={f.name}
                        alt={f.name}
                        client={client}
                        sizeClassName="h-20 w-full max-w-[120px]"
                      />
                    </div>
                  ) : (
                    <div className="w-16 h-16 bg-accent rounded flex items-center justify-center mb-1">
                      <span className="text-xs text-muted-foreground">{fileIconText(f).toUpperCase()}</span>
                    </div>
                  )}
                  <span className="text-xs text-center truncate w-full">{decodeStorageName(f.name)}</span>
                  {!f.is_folder ? (
                    <span className="text-[0.65rem] text-zinc-600">{formatBytes(f.size)}</span>
                  ) : null}
                </Card>
              ))}
              {filteredFiles.length === 0 && path.length === 0 ? (
                <div className="col-span-full">
                  <EmptyState
                    title="This bucket is empty"
                    description="Upload files or drag and drop to get started."
                    action={handleUpload}
                    actionLabel="Upload Files"
                  />
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* File details panel */}
        {selectedFile && currentBucket ? (
          <div className="w-[300px] flex-shrink-0">
            <Card className="p-4">
              <div className="flex justify-between items-center mb-3">
                <h4 className="m-0 truncate">{decodeStorageName(selectedFile.name)}</h4>
                <Button size="xs" onClick={() => setSelectedFile(null)}>Close</Button>
              </div>
              <FilePreview file={selectedFile} bucket={currentBucket} client={client} currentPath={path} />
              <div className="flex gap-2 mt-4">
                <Button size="xs" onClick={() => { void handleDownload(selectedFile) }}>Download</Button>
                <Button size="xs" variant="destructive" onClick={() => requestDelete(new Set([selectedFile.id]))}>
                  Delete
                </Button>
              </div>
            </Card>
          </div>
        ) : null}
      </div>

      {/* Create bucket dialog */}
      {showCreateBucket ? (
        <CreateBucketDialog
          onConfirm={(name, isPublic) => { void handleCreateBucket(name, isPublic) }}
          onCancel={() => setShowCreateBucket(false)}
        />
      ) : null}

      {/* Pre-create recommendation */}
      {showCreateBucketWarning ? (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="p-6 max-w-[560px] w-full">
            <h3 className="m-0 mb-2">Create bucket in Studio?</h3>
            <p className="text-sm text-muted-foreground mb-2">
              It is recommended to create storage buckets via your schema so bucket configuration is versioned and reproducible in migrations.
            </p>
            <p className="text-sm text-muted-foreground mb-4">
              Continue only if you intentionally want a manual bucket.
            </p>
            <div className="flex gap-2 justify-end">
              <Button onClick={() => setShowCreateBucketWarning(false)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  setShowCreateBucketWarning(false)
                  setShowCreateBucket(true)
                }}
              >
                I understand, continue
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {/* Create folder dialog */}
      {showCreateFolder ? (
        <CreateFolderDialog
          onConfirm={handleCreateFolder}
          onCancel={() => setShowCreateFolder(false)}
        />
      ) : null}

      {/* Delete confirmation */}
      {pendingDeleteIds ? (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="p-6 max-w-[400px]">
            <h3 className="text-red-400 m-0 mb-2">Delete Files</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Delete {pendingDeleteIds.size} {pendingDeleteIds.size === 1 ? "item" : "items"}? This cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <Button onClick={() => setPendingDeleteIds(null)}>Cancel</Button>
              <Button variant="destructive" onClick={() => { void handleDelete() }}>Delete</Button>
            </div>
          </Card>
        </div>
      ) : null}
    </>
  )
}
