/**
 * Client-side image preparation for upload: a photo that would blow the
 * per-image model budget (3M base64 chars of a vision model's input) is
 * downscaled to fit — 2048px on the long edge, JPEG q0.85. Everything else
 * passes through untouched; a failed canvas falls back to the original,
 * which the server demotes to a file reference.
 */
const MAX_BASE64_CHARS = 3_000_000;
const MAX_EDGE = 2048;

const fitsBudget = (bytes: number): boolean => (bytes / 3) * 4 <= MAX_BASE64_CHARS;

/** Prepare one file for upload; oversized images become JPEGs that fit. */
export async function prepareForUpload(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/") || fitsBudget(file.size)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (context === null) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const jpeg = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    return jpeg ?? file;
  } catch {
    return file;
  }
}

/** The name an uploaded file carries after preparation (downscaled ones are JPEGs). */
export const uploadNameOf = (file: File, prepared: Blob): string =>
  prepared === file ? file.name : `${file.name.replace(/\.[^.]*$/, "")}.jpg`;
