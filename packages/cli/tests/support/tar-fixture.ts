import { gzipSync } from "node:zlib"

/**
 * A gzipped tarball shaped like GitHub's codeload archives: a pax global header carrying the
 * commit, one root directory, and a pax `path` record for a name too long for the ustar header.
 */

export interface FixtureFile {
  path: string
  content: string
}

const BLOCK = 512

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`
}

function header(name: string, size: number, type: string): Buffer {
  const block = Buffer.alloc(BLOCK)
  block.write(name.slice(0, 100), 0, "utf8")
  block.write(octal(0o644, 8), 100)
  block.write(octal(0, 8), 108)
  block.write(octal(0, 8), 116)
  block.write(octal(size, 12), 124)
  block.write(octal(0, 12), 136)
  block.write("        ", 148)
  block.write(type, 156)
  block.write("ustar\0", 257)
  block.write("00", 263)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148)
  return block
}

function padded(data: Buffer): Buffer {
  const rest = data.length % BLOCK
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rest)])
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let length = body.length + 1
  while (`${length}${body}`.length !== length) length += 1
  return `${length}${body}`
}

function entry(path: string, data: Buffer, type: string): Buffer[] {
  const blocks: Buffer[] = []
  // A NUL would end the ustar name field, so a name with one travels as a pax record, as a long one does.
  if (path.length > 100 || path.includes("\0")) {
    const pax = Buffer.from(paxRecord("path", path))
    blocks.push(header("PaxHeader", pax.length, "x"), padded(pax))
  }
  blocks.push(header(path, data.length, type))
  if (data.length > 0) blocks.push(padded(data))
  return blocks
}

/** `files` named exactly as given, with no root folder or global header: for names an archive should not have. */
export function plainTarball(files: readonly FixtureFile[]): Buffer {
  const blocks = files.flatMap((file) => entry(file.path, Buffer.from(file.content), "0"))
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(BLOCK * 2)]))
}

/** `files` under `root/`, each directory of theirs listed before them, as git archive does. */
export function fixtureTarball(root: string, files: readonly FixtureFile[]): Buffer {
  const global = Buffer.from(paxRecord("comment", "0123456789abcdef0123456789abcdef01234567"))
  const blocks: Buffer[] = [header("pax_global_header", global.length, "g"), padded(global)]
  const directories = new Set<string>([`${root}/`])
  for (const file of files) {
    const parts = file.path.split("/")
    for (let i = 1; i < parts.length; i++) directories.add(`${root}/${parts.slice(0, i).join("/")}/`)
  }
  for (const directory of [...directories].sort()) blocks.push(...entry(directory, Buffer.alloc(0), "5"))
  for (const file of files) blocks.push(...entry(`${root}/${file.path}`, Buffer.from(file.content), "0"))
  blocks.push(Buffer.alloc(BLOCK * 2))
  return gzipSync(Buffer.concat(blocks))
}
