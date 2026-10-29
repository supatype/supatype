/**
 * The file backend: object bytes in a directory on local disk (`STORAGE_BACKEND=file`), for native
 * `supatype dev` and a single box with no S3. Bucket and object metadata stay in Postgres, as with
 * S3; this keeps only the bytes and the content type they were stored with.
 *
 * Object keys are S3 keys, so any string: case matters, `/` separates folders, and `..`, `:`, `*`
 * or a trailing dot are all allowed. Each segment is written as a name every filesystem keeps apart
 * and none can climb out of the root with: lowercase letters, digits, `_` and `-` as they are, every
 * other byte as `%XX`, so no name differs from another by case alone, and no `.` survives to make
 * `..` or a trailing dot Windows would strip. Folders are `d…` and objects `f…`, so an object and a
 * folder of one name never collide. A segment too long for a filesystem name is stored by its hash.
 */
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

/** What a stored object reads back as. */
export interface StoredBytes {
  body: Buffer
  contentType: string
  contentLength: number
}

/** Longest encoded segment written as itself; most filesystems allow 255 bytes in a name. */
const MAX_SEGMENT = 200

/** One key segment as a filesystem name, after its `d`, `f` or `b` prefix. */
function encodeSegment(segment: string): string {
  let out = ""
  for (const byte of Buffer.from(segment, "utf8")) {
    const char = String.fromCharCode(byte)
    out += /[a-z0-9_-]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
  }
  return out.length <= MAX_SEGMENT ? out : `~${createHash("sha256").update(segment).digest("hex")}`
}

/** An error the object routes read as a missing object, named as S3 names it. */
function noSuchKey(bucket: string, key: string): Error {
  return Object.assign(new Error(`No object ${key} in ${bucket}`), { name: "NoSuchKey" })
}

function isMissingFile(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT"
}

/** The file backend rooted at `root`. */
export class DiskStore {
  constructor(private readonly root: string) {}

  async ensureBucket(bucket: string): Promise<void> {
    await mkdir(this.bucketDir(bucket), { recursive: true })
  }

  async deleteBucket(bucket: string): Promise<void> {
    await rm(this.bucketDir(bucket), { recursive: true, force: true })
  }

  async putObject(bucket: string, key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> {
    const path = this.objectPath(bucket, key)
    await mkdir(dirname(path), { recursive: true })
    await writeAtomically(typePath(path), contentType)
    await writeAtomically(path, body)
  }

  async getObject(bucket: string, key: string): Promise<StoredBytes> {
    const path = this.objectPath(bucket, key)
    try {
      const body = await readFile(path)
      const contentType = await readFile(typePath(path), "utf8").catch(() => "application/octet-stream")
      return { body, contentType, contentLength: body.length }
    } catch (err) {
      if (isMissingFile(err)) throw noSuchKey(bucket, key)
      throw err
    }
  }

  async deleteObjects(bucket: string, keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      const path = this.objectPath(bucket, key)
      await rm(path, { force: true })
      await rm(typePath(path), { force: true })
    }
  }

  private bucketDir(bucket: string): string {
    return join(this.root, `b${encodeSegment(bucket)}`)
  }

  private objectPath(bucket: string, key: string): string {
    const segments = key.split("/")
    const leaf = segments.pop() ?? ""
    return join(this.bucketDir(bucket), ...segments.map((s) => `d${encodeSegment(s)}`), `f${encodeSegment(leaf)}`)
  }
}

/** Where an object's content type is kept. Encoded names never hold a `.`, so no object has this name. */
function typePath(path: string): string {
  return `${path}.type`
}

/** Writes through a temporary file and a rename, so a reader never sees half an object. */
async function writeAtomically(path: string, data: string | Buffer | Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, data)
  await rename(temporary, path)
}
