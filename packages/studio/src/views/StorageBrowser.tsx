import React, { useState, useRef } from "react"
import { useStudioClient } from "../StudioApp.js"
import { Badge, Button, Card, Th, Td } from "../components/ui.js"

interface StorageFile {
  name: string
  size: number
  type: string
  updated_at: string
  is_folder: boolean
}

interface Bucket {
  name: string
  public: boolean
  file_count: number
}

const mockBuckets: Bucket[] = [
  { name: "avatars", public: true, file_count: 42 },
  { name: "uploads", public: false, file_count: 156 },
  { name: "media", public: true, file_count: 89 },
]

const mockFiles: StorageFile[] = [
  { name: "photos/", size: 0, type: "folder", updated_at: "2026-03-01T10:00:00Z", is_folder: true },
  { name: "documents/", size: 0, type: "folder", updated_at: "2026-02-15T14:00:00Z", is_folder: true },
  { name: "profile.jpg", size: 245760, type: "image/jpeg", updated_at: "2026-03-10T08:30:00Z", is_folder: false },
  { name: "resume.pdf", size: 1048576, type: "application/pdf", updated_at: "2026-03-05T16:00:00Z", is_folder: false },
  { name: "data.json", size: 4096, type: "application/json", updated_at: "2026-03-08T12:00:00Z", is_folder: false },
]

function formatBytes(bytes: number): string {
  if (bytes === 0) return "\u2014"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

function fileIcon(file: StorageFile): string {
  if (file.is_folder) return "\uD83D\uDCC1"
  if (file.type.startsWith("image/")) return "\uD83C\uDFBC"
  if (file.type === "application/pdf") return "\uD83D\uDCC4"
  return "\uD83D\uDCC3"
}

export function StorageBrowser(): React.ReactElement {
  const client = useStudioClient()
  const [buckets] = useState<Bucket[]>(mockBuckets)
  const [selectedBucket, setSelectedBucket] = useState(mockBuckets[0]?.name ?? "")
  const [files, setFiles] = useState<StorageFile[]>(mockFiles)
  const [path, setPath] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const breadcrumb = [selectedBucket, ...path]

  const handleUpload = () => {
    fileInputRef.current?.click()
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (!fileList || fileList.length === 0) return
    setUploading(true)
    await new Promise((r) => setTimeout(r, 500))
    setUploading(false)
  }

  const navigateToFolder = (folderName: string) => {
    setPath((prev) => [...prev, folderName.replace("/", "")])
  }

  const navigateUp = () => {
    setPath((prev) => prev.slice(0, -1))
  }

  const handleDelete = (fileName: string) => {
    setFiles((prev) => prev.filter((f) => f.name !== fileName))
  }

  return (
    <>
      <div className="flex items-center justify-end mb-4">
        <Button variant="primary" onClick={handleUpload} disabled={uploading}>
          {uploading ? "Uploading..." : "Upload File"}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => void handleFileSelect(e)}
        />
      </div>

      <div className="grid grid-cols-[200px_1fr] gap-4">
        {/* Bucket list */}
        <Card className="p-2 flex flex-col gap-0.5">
          {buckets.map((b) => (
            <button
              key={b.name}
              className={`flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground rounded-md transition-colors${b.name === selectedBucket ? " bg-accent text-foreground font-medium" : ""}`}
              onClick={() => { setSelectedBucket(b.name); setPath([]) }}
            >
              <span>{b.name}</span>
              <span className="ml-auto flex gap-2 items-center">
                {b.public ? <Badge className="text-[0.6rem]">public</Badge> : null}
                <span className="text-zinc-600 text-[0.7rem]">{b.file_count}</span>
              </span>
            </button>
          ))}
        </Card>

        {/* File browser */}
        <div>
          {/* Breadcrumb */}
          <div className="flex gap-1 items-center mb-4 text-xs">
            {breadcrumb.map((segment, i) => (
              <React.Fragment key={i}>
                {i > 0 ? <span className="text-zinc-600">/</span> : null}
                <Button
                  variant="secondary"
                  size="xs"
                  className="px-2 py-0.5"
                  onClick={() => {
                    if (i === 0) setPath([])
                    else setPath(path.slice(0, i))
                  }}
                >
                  {segment}
                </Button>
              </React.Fragment>
            ))}
          </div>

          {/* File table */}
          <Card className="overflow-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <Th className="w-8" />
                  <Th>Name</Th>
                  <Th>Size</Th>
                  <Th>Type</Th>
                  <Th>Modified</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {path.length > 0 ? (
                  <tr className="border-b border-border hover:bg-accent/50">
                    <Td />
                    <Td>
                      <button
                        className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                        onClick={navigateUp}
                      >
                        ..
                      </button>
                    </Td>
                    <td colSpan={4} />
                  </tr>
                ) : null}
                {files.map((f) => (
                  <tr key={f.name} className="border-b border-border hover:bg-accent/50">
                    <Td className="text-center">{fileIcon(f)}</Td>
                    <Td>
                      {f.is_folder ? (
                        <button
                          className="font-medium text-primary hover:underline"
                          onClick={() => navigateToFolder(f.name)}
                        >
                          {f.name}
                        </button>
                      ) : (
                        <span>{f.name}</span>
                      )}
                    </Td>
                    <Td className="text-xs text-muted-foreground">{formatBytes(f.size)}</Td>
                    <Td className="text-xs text-muted-foreground">{f.is_folder ? "\u2014" : f.type}</Td>
                    <Td className="text-xs text-muted-foreground">{new Date(f.updated_at).toLocaleDateString()}</Td>
                    <Td>
                      {!f.is_folder ? (
                        <div className="flex gap-1">
                          <Button size="xs">Download</Button>
                          <Button size="xs" variant="destructive" onClick={() => handleDelete(f.name)}>Delete</Button>
                        </div>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      </div>
    </>
  )
}
