import React, { useState, useRef, useCallback, useMemo } from "react"
import { useStudioClient } from "../StudioApp.js"
import { cn } from "../lib/utils.js"
import { Badge, Button, Card, Input, Select, Th, Td } from "../components/ui.js"

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
  name: string
  public: boolean
  file_count: number
  size_bytes: number
  allowed_mime_types: string[] | null
  max_file_size: number | null
}

interface UploadProgress {
  fileName: string
  progress: number
  error: string | null
  done: boolean
}

// ─── Mock Data ────────────────────────────────────────────────────────────────

const mockBuckets: Bucket[] = [
  { name: "avatars", public: true, file_count: 42, size_bytes: 15728640, allowed_mime_types: ["image/jpeg", "image/png", "image/webp"], max_file_size: 5242880 },
  { name: "uploads", public: false, file_count: 156, size_bytes: 524288000, allowed_mime_types: null, max_file_size: 52428800 },
  { name: "media", public: true, file_count: 89, size_bytes: 104857600, allowed_mime_types: ["image/*", "video/*", "audio/*"], max_file_size: 104857600 },
]

const mockFiles: StorageFile[] = [
  { id: "f1", name: "photos", size: 0, type: "folder", updated_at: "2026-03-01T10:00:00Z", created_at: "2026-01-01T10:00:00Z", is_folder: true, owner_id: null, public_url: null },
  { id: "f2", name: "documents", size: 0, type: "folder", updated_at: "2026-02-15T14:00:00Z", created_at: "2026-01-01T10:00:00Z", is_folder: true, owner_id: null, public_url: null },
  { id: "f3", name: "profile.jpg", size: 245760, type: "image/jpeg", updated_at: "2026-03-10T08:30:00Z", created_at: "2026-03-10T08:30:00Z", is_folder: false, owner_id: "u1", public_url: "https://storage.supatype.dev/avatars/profile.jpg" },
  { id: "f4", name: "resume.pdf", size: 1048576, type: "application/pdf", updated_at: "2026-03-05T16:00:00Z", created_at: "2026-03-05T16:00:00Z", is_folder: false, owner_id: "u1", public_url: null },
  { id: "f5", name: "data.json", size: 4096, type: "application/json", updated_at: "2026-03-08T12:00:00Z", created_at: "2026-03-08T12:00:00Z", is_folder: false, owner_id: "u2", public_url: null },
  { id: "f6", name: "hero-banner.png", size: 2097152, type: "image/png", updated_at: "2026-03-12T10:00:00Z", created_at: "2026-03-12T10:00:00Z", is_folder: false, owner_id: "u1", public_url: "https://storage.supatype.dev/avatars/hero-banner.png" },
  { id: "f7", name: "background.webp", size: 819200, type: "image/webp", updated_at: "2026-03-11T15:00:00Z", created_at: "2026-03-11T15:00:00Z", is_folder: false, owner_id: "u3", public_url: "https://storage.supatype.dev/avatars/background.webp" },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "\u2014"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
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

// ─── File Preview Panel ───────────────────────────────────────────────────────

function FilePreview({ file, bucket }: { file: StorageFile; bucket: Bucket }): React.ReactElement {
  const [signedUrl, setSignedUrl] = useState<string | null>(null)

  const generateSignedUrl = () => {
    // Mock: in production this would call the storage API
    setSignedUrl(`https://storage.supatype.dev/${bucket.name}/${file.name}?token=mock-signed-url-${Date.now()}&expires=3600`)
  }

  return (
    <div>
      {file.type.startsWith("image/") ? (
        <div className="bg-accent/30 rounded-md p-4 flex items-center justify-center mb-3">
          <div className="w-full max-w-[300px] aspect-video bg-border/50 rounded flex items-center justify-center text-muted-foreground text-sm">
            [Image preview: {file.name}]
          </div>
        </div>
      ) : file.type === "application/pdf" ? (
        <div className="bg-accent/30 rounded-md p-4 flex items-center justify-center mb-3 min-h-[200px]">
          <span className="text-muted-foreground text-sm">PDF preview: {file.name}</span>
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
          <span className="break-all">{file.name}</span>
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
      {file.public_url ? (
        <div className="mt-3">
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-1">Public URL</label>
          <Input value={file.public_url} readOnly className="font-mono text-xs" />
        </div>
      ) : null}

      {/* Signed URL generator (for private buckets) */}
      {!bucket.public ? (
        <div className="mt-3">
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-1">Pre-signed URL</label>
          {signedUrl ? (
            <Input value={signedUrl} readOnly className="font-mono text-xs" />
          ) : (
            <Button size="xs" onClick={generateSignedUrl}>Generate Signed URL (1h)</Button>
          )}
        </div>
      ) : null}
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

  // Bucket state
  const [buckets] = useState<Bucket[]>(mockBuckets)
  const [selectedBucket, setSelectedBucket] = useState(mockBuckets[0]?.name ?? "")

  // Files state
  const [files, setFiles] = useState<StorageFile[]>(mockFiles)
  const [path, setPath] = useState<string[]>([])

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
  const [showCreateFolder, setShowCreateFolder] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const currentBucket = buckets.find((b) => b.name === selectedBucket)
  const breadcrumb = [selectedBucket, ...path]

  // Filtered files
  const filteredFiles = useMemo(() => {
    let result = files
    if (search) {
      result = result.filter((f) => f.name.toLowerCase().includes(search.toLowerCase()))
    }
    return result
  }, [files, search])

  // Navigation
  const navigateToFolder = (folderName: string) => {
    setPath((prev) => [...prev, folderName])
    setSelectedFile(null)
    setSelectedIds(new Set())
  }

  const navigateUp = () => {
    setPath((prev) => prev.slice(0, -1))
    setSelectedFile(null)
  }

  const navigateToBreadcrumb = (index: number) => {
    if (index === 0) setPath([])
    else setPath(path.slice(0, index))
    setSelectedFile(null)
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

    // Mock upload progress
    for (let i = 0; i < newUploads.length; i++) {
      const file = fileList[i]!
      for (let p = 0; p <= 100; p += 20) {
        await new Promise((r) => setTimeout(r, 100))
        setUploads((prev) => prev.map((u) =>
          u.fileName === file.name ? { ...u, progress: p } : u
        ))
      }
      // Add the file to the list
      const newFile: StorageFile = {
        id: `f-${Date.now()}-${i}`,
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        is_folder: false,
        owner_id: null,
        public_url: currentBucket?.public ? `https://storage.supatype.dev/${selectedBucket}/${path.join("/")}${path.length > 0 ? "/" : ""}${file.name}` : null,
      }
      setFiles((prev) => [...prev, newFile])
      setUploads((prev) => prev.map((u) =>
        u.fileName === file.name ? { ...u, done: true, progress: 100 } : u
      ))
    }

    // Clear completed uploads after a delay
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
  const handleDelete = (ids: Set<string>) => {
    setFiles((prev) => prev.filter((f) => !ids.has(f.id)))
    setSelectedIds(new Set())
    setSelectedFile(null)
    setShowDeleteConfirm(false)
  }

  const handleCreateFolder = (name: string) => {
    const newFolder: StorageFile = {
      id: `f-${Date.now()}`,
      name,
      size: 0,
      type: "folder",
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      is_folder: true,
      owner_id: null,
      public_url: null,
    }
    setFiles((prev) => [newFolder, ...prev])
    setShowCreateFolder(false)
  }

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
          <Button variant="destructive" size="sm" onClick={() => setShowDeleteConfirm(true)}>
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

      <div className="flex gap-4 h-full">
        {/* Bucket list sidebar */}
        <div className="w-[200px] flex-shrink-0">
          <Card className="p-1.5 flex flex-col gap-0.5">
            {buckets.map((b) => (
              <button
                key={b.name}
                className={cn(
                  "flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground rounded-md transition-colors",
                  b.name === selectedBucket && "bg-accent text-foreground font-medium"
                )}
                onClick={() => { setSelectedBucket(b.name); setPath([]); setSelectedFile(null); setSelectedIds(new Set()) }}
              >
                <span className="truncate">{b.name}</span>
                <span className="ml-auto flex gap-1.5 items-center flex-shrink-0">
                  {b.public ? <Badge className="text-[0.55rem] px-1">pub</Badge> : null}
                  <span className="text-zinc-600 text-[0.7rem]">{b.file_count}</span>
                </span>
              </button>
            ))}
          </Card>
          {/* Bucket info */}
          {currentBucket ? (
            <div className="mt-2 text-xs text-muted-foreground px-2">
              <div>Size: {formatBytes(currentBucket.size_bytes)}</div>
              {currentBucket.max_file_size ? <div>Max file: {formatBytes(currentBucket.max_file_size)}</div> : null}
              {currentBucket.allowed_mime_types ? <div>Types: {currentBucket.allowed_mime_types.join(", ")}</div> : null}
            </div>
          ) : null}
        </div>

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

          {isDragOver ? (
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
                            <span className="text-muted-foreground">[dir]</span> {f.name}
                          </button>
                        ) : (
                          <button
                            className="hover:text-primary flex items-center gap-1.5"
                            onClick={() => setSelectedFile(f)}
                          >
                            <span className="text-muted-foreground text-xs">[{fileIconText(f)}]</span> {f.name}
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
                            <Button size="xs">Download</Button>
                            <Button size="xs" variant="destructive" onClick={() => handleDelete(new Set([f.id]))}>
                              Delete
                            </Button>
                          </div>
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                  {filteredFiles.length === 0 && path.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-center py-8 text-muted-foreground text-sm">
                        This bucket is empty. Upload files or drag and drop.
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
                  ) : f.type.startsWith("image/") ? (
                    <div className="w-16 h-16 bg-accent rounded flex items-center justify-center mb-1">
                      <span className="text-xs text-muted-foreground">IMG</span>
                    </div>
                  ) : (
                    <div className="w-16 h-16 bg-accent rounded flex items-center justify-center mb-1">
                      <span className="text-xs text-muted-foreground">{fileIconText(f).toUpperCase()}</span>
                    </div>
                  )}
                  <span className="text-xs text-center truncate w-full">{f.name}</span>
                  {!f.is_folder ? (
                    <span className="text-[0.65rem] text-zinc-600">{formatBytes(f.size)}</span>
                  ) : null}
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* File details panel */}
        {selectedFile && currentBucket ? (
          <div className="w-[300px] flex-shrink-0">
            <Card className="p-4">
              <div className="flex justify-between items-center mb-3">
                <h4 className="m-0 truncate">{selectedFile.name}</h4>
                <Button size="xs" onClick={() => setSelectedFile(null)}>Close</Button>
              </div>
              <FilePreview file={selectedFile} bucket={currentBucket} />
              <div className="flex gap-2 mt-4">
                <Button size="xs">Download</Button>
                <Button size="xs" variant="destructive" onClick={() => handleDelete(new Set([selectedFile.id]))}>
                  Delete
                </Button>
              </div>
            </Card>
          </div>
        ) : null}
      </div>

      {/* Create folder dialog */}
      {showCreateFolder ? (
        <CreateFolderDialog
          onConfirm={handleCreateFolder}
          onCancel={() => setShowCreateFolder(false)}
        />
      ) : null}

      {/* Delete confirmation */}
      {showDeleteConfirm ? (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="p-6 max-w-[400px]">
            <h3 className="text-red-400 m-0 mb-2">Delete Files</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Delete {selectedIds.size} selected {selectedIds.size === 1 ? "item" : "items"}? This cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <Button onClick={() => setShowDeleteConfirm(false)}>Cancel</Button>
              <Button variant="destructive" onClick={() => handleDelete(selectedIds)}>Delete</Button>
            </div>
          </Card>
        </div>
      ) : null}
    </>
  )
}
