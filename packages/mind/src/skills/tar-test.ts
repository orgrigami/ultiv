import { gzipSync } from "node:zlib";

/** Test-only ustar builder: the smallest real tar that walkTar can read. */
export const BLOCK = 512;

export const tarHeader = (path: string, size: number, typeflag = "0"): Buffer => {
  const block = Buffer.alloc(BLOCK, 0);
  block.write(path, 0, Math.min(path.length, 100), "utf8");
  block.write("0000644\0", 100, 8, "utf8");
  block.write("0000000\0", 108, 8, "utf8");
  block.write("0000000\0", 116, 8, "utf8");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  block.write("00000000000\0", 136, 12, "utf8");
  block.write("        ", 148, 8, "utf8");
  block.write(typeflag, 156, 1, "utf8");
  block.write("ustar\0", 257, 6, "utf8");
  return block;
};

export const tarPadded = (content: string): Buffer => {
  const data = Buffer.from(content, "utf8");
  const fill = (BLOCK - (data.length % BLOCK)) % BLOCK;
  return Buffer.concat([data, Buffer.alloc(fill, 0)]);
};

export const tarOf = (
  ...entries: readonly { path: string; typeflag?: string; content?: string }[]
): Buffer =>
  Buffer.concat(
    entries.map((entry) =>
      Buffer.concat([
        tarHeader(entry.path, entry.content?.length ?? 0, entry.typeflag ?? "0"),
        tarPadded(entry.content ?? ""),
      ]),
    ),
  );

export const gzOf = (tar: Buffer): Buffer => gzipSync(tar);
