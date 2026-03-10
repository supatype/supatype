import sharp from "sharp"

export interface TransformOptions {
  width?: number
  height?: number
  format?: "webp" | "avif" | "png" | "jpeg"
  quality?: number
  resize?: "cover" | "contain" | "fill" | "inside" | "outside"
}

/** Parse transform options from URL search params. */
export function parseTransformParams(params: URLSearchParams): TransformOptions | null {
  const width = params.get("width")
  const height = params.get("height")
  const format = params.get("format")
  const quality = params.get("quality")
  const resize = params.get("resize")

  if (!width && !height && !format && !quality) return null

  const opts: TransformOptions = {}
  if (width) opts.width = clamp(parseInt(width, 10), 1, 4096)
  if (height) opts.height = clamp(parseInt(height, 10), 1, 4096)
  if (format && isValidFormat(format)) opts.format = format
  if (quality) opts.quality = clamp(parseInt(quality, 10), 1, 100)
  if (resize && isValidResize(resize)) opts.resize = resize

  return opts
}

/** Apply image transformations and return the result buffer + content type. */
export async function transformImage(
  input: Buffer,
  opts: TransformOptions,
): Promise<{ buffer: Buffer; contentType: string }> {
  let pipeline = sharp(input)

  if (opts.width !== undefined || opts.height !== undefined) {
    pipeline = pipeline.resize(opts.width, opts.height, {
      fit: opts.resize ?? "cover",
      withoutEnlargement: true,
    })
  }

  const format = opts.format ?? "webp"
  const quality = opts.quality ?? 80

  switch (format) {
    case "webp":
      pipeline = pipeline.webp({ quality })
      break
    case "avif":
      pipeline = pipeline.avif({ quality })
      break
    case "png":
      pipeline = pipeline.png({ quality })
      break
    case "jpeg":
      pipeline = pipeline.jpeg({ quality })
      break
  }

  const buffer = await pipeline.toBuffer()
  return { buffer, contentType: `image/${format}` }
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.max(min, Math.min(max, value))
}

function isValidFormat(f: string): f is TransformOptions["format"] & string {
  return f === "webp" || f === "avif" || f === "png" || f === "jpeg"
}

function isValidResize(r: string): r is NonNullable<TransformOptions["resize"]> {
  return r === "cover" || r === "contain" || r === "fill" || r === "inside" || r === "outside"
}
