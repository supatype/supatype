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

/**
 * The stored bytes cannot be rendered: empty, not an image, or a format sharp cannot decode.
 *
 * The caller asked to transform something that is not a picture, so the route answers 400 with
 * Supabase's message for the same case rather than letting sharp's error become a 500.
 */
export class UnrenderableImageError extends Error {
  constructor(cause: unknown) {
    super("The source image is invalid or unsupported for rendering", { cause })
    this.name = "UnrenderableImageError"
  }
}

/** Apply image transformations and return the result buffer + content type. */
export async function transformImage(
  input: Buffer,
  opts: TransformOptions,
): Promise<{ buffer: Buffer; contentType: string }> {
  const format = opts.format ?? "webp"
  try {
    const buffer = await pipelineFor(input, opts, format).toBuffer()
    return { buffer, contentType: `image/${format}` }
  } catch (err) {
    // Every failure here is sharp refusing its input: an empty buffer is refused when the
    // pipeline is built, an undecodable one when it runs.
    throw new UnrenderableImageError(err)
  }
}

function pipelineFor(input: Buffer, opts: TransformOptions, format: NonNullable<TransformOptions["format"]>): sharp.Sharp {
  let pipeline = sharp(input)

  if (opts.width !== undefined || opts.height !== undefined) {
    pipeline = pipeline.resize(opts.width, opts.height, {
      fit: opts.resize ?? "cover",
      withoutEnlargement: true,
    })
  }

  const quality = opts.quality ?? 80
  switch (format) {
    case "webp":
      return pipeline.webp({ quality })
    case "avif":
      return pipeline.avif({ quality })
    case "png":
      return pipeline.png({ quality })
    case "jpeg":
      return pipeline.jpeg({ quality })
  }
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
