/**
 * Attachments, client side: the upload cap (the server answers 413 over it),
 * which mimes are images, and the mark the server puts in front of an
 * input's attachment reference lines — display text cuts there.
 */

/** Per-file upload cap; rest/artifacts enforces the same number. */
export const MAX_UPLOAD_BYTES = 10_000_000;

/** The reference-line block an input's attachments append on the model side. */
export const ATTACHMENTS_MARK = "\n\nAttached artifacts:";

/** Cut the machinery off display text that carried attachments. */
export const displayText = (text: string): string => (text.split(ATTACHMENTS_MARK)[0] ?? "").trim();

export const isImageMime = (mime: string): boolean => mime.startsWith("image/");
