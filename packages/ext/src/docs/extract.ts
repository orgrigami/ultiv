/**
 * Plain text out of a PDF or a Word (.docx) file, with no dependencies:
 * Node's zlib plus small readers for the two formats.
 *
 * - DOCX: a zip reader finds word/document.xml; paragraphs, tabs, breaks and
 *   table cells become text.
 * - PDF: every content stream (FlateDecode or none) is scanned for text
 *   operators (Tj, TJ, ', "), with line breaks on moves. Fonts with a
 *   ToUnicode map (most modern PDFs) are decoded through it; others read as
 *   Latin-1.
 *
 * Not covered: scanned pages (no OCR), encrypted PDFs, other filters
 * (LZW, JBIG2...), object streams holding content, .doc (pre-2007 Word).
 * Every size is capped, so a hostile file can't blow up memory.
 */
import { inflateRawSync, inflateSync } from "node:zlib";

export const MAX_DOCUMENT_BYTES = 25_000_000;
const MAX_INFLATED = 50_000_000;
const MAX_TEXT_CHARS = 2_000_000;

export type DocumentKind = "pdf" | "docx";

export type Extracted =
  | { readonly ok: true; readonly kind: DocumentKind; readonly text: string }
  | { readonly ok: false; readonly reason: string };

/** What the bytes are, by their first bytes (not the name). */
export const documentKindOf = (bytes: Uint8Array): DocumentKind | "zip" | undefined => {
  const head = Buffer.from(bytes.subarray(0, 5)).toString("latin1");
  if (head.startsWith("%PDF")) return "pdf";
  if (head.startsWith("PK\u0003\u0004")) return "zip";
  return undefined;
};

export const extractDocumentText = (bytes: Uint8Array): Extracted => {
  if (bytes.byteLength > MAX_DOCUMENT_BYTES)
    return { ok: false, reason: `the file is over ${MAX_DOCUMENT_BYTES / 1_000_000} MB` };
  const kind = documentKindOf(bytes);
  try {
    if (kind === "pdf") return finish("pdf", pdfText(Buffer.from(bytes)));
    if (kind === "zip") {
      const xml = zipEntry(Buffer.from(bytes), "word/document.xml");
      if (xml === undefined)
        return { ok: false, reason: "it's a zip file, but not a Word document" };
      return finish("docx", docxText(xml.toString("utf8")));
    }
  } catch (cause) {
    return {
      ok: false,
      reason: `couldn't read it (${cause instanceof Error ? cause.message : "damaged file"})`,
    };
  }
  return { ok: false, reason: "it isn't a PDF or a Word (.docx) file" };
};

const finish = (kind: DocumentKind, raw: string): Extracted => {
  const text = raw
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
  if (text === "")
    return {
      ok: false,
      reason:
        kind === "pdf"
          ? "no text found: it may be scanned pages (there is no OCR) or use an unusual font"
          : "the document has no text",
    };
  return { ok: true, kind, text };
};

// ---- zip ------------------------------------------------------------------

/** One stored or deflated entry's bytes, by exact name. */
const zipEntry = (zip: Buffer, name: string): Buffer | undefined => {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a complete zip file");
  const entries = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries && at + 46 <= zip.length; n += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("bad zip directory");
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const entryName = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extra + comment;
    if (entryName !== name) continue;
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error("bad zip entry");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compressed);
    if (method === 0) return data;
    if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_INFLATED });
    throw new Error("unsupported zip compression");
  }
  return undefined;
};

// ---- docx -----------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, code: string) => {
    if (code.startsWith("#x")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    return ENTITIES[code] ?? whole;
  });

export const docxText = (xml: string): string => {
  const body = xml.replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, "");
  let out = "";
  const token = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>|<\/w:p>|<\/w:tc>/g;
  for (let match = token.exec(body); match !== null; match = token.exec(body)) {
    const tag = match[0];
    if (match[1] !== undefined) out += decodeEntities(match[1]);
    else if (tag === "<w:tab/>" || tag === "</w:tc>") out += "\t";
    else out += "\n";
  }
  return out;
};

// ---- pdf ------------------------------------------------------------------

interface PdfObject {
  readonly dict: string;
  readonly stream?: Buffer;
}

/** Every `n 0 obj ... endobj` with its dictionary text and decoded stream, if any. */
const pdfObjects = (pdf: Buffer): Map<number, PdfObject> => {
  const text = pdf.toString("latin1");
  const objects = new Map<number, PdfObject>();
  const head = /(\d+)\s+\d+\s+obj\b/g;
  for (let match = head.exec(text); match !== null; match = head.exec(text)) {
    const start = match.index + match[0].length;
    const end = text.indexOf("endobj", start);
    if (end < 0) break;
    const body = text.slice(start, end);
    const streamAt = body.search(/\bstream\r?\n/);
    if (streamAt < 0) {
      objects.set(Number(match[1]), { dict: body });
      head.lastIndex = end;
      continue;
    }
    const dict = body.slice(0, streamAt);
    const dataStart = start + streamAt + (body[streamAt + 6] === "\r" ? 8 : 7);
    const dataEnd = text.lastIndexOf("endstream", end);
    let data = pdf.subarray(dataStart, Math.max(dataStart, dataEnd));
    if (/\/Filter\s*\[?\s*\/FlateDecode\s*\]?/.test(dict)) {
      try {
        data = inflateSync(data, { maxOutputLength: MAX_INFLATED });
      } catch {
        data = Buffer.alloc(0);
      }
    } else if (/\/Filter/.test(dict)) {
      data = Buffer.alloc(0);
    }
    objects.set(Number(match[1]), { dict, stream: data });
    head.lastIndex = end;
  }
  return objects;
};

interface CMap {
  readonly bytes: 1 | 2;
  readonly map: Map<number, string>;
  /** A simple font's named encoding, for codes the map doesn't cover. */
  readonly encoding?: TextDecoder;
}

const NAMED_ENCODINGS: Record<string, string> = {
  MacRomanEncoding: "macintosh",
  WinAnsiEncoding: "windows-1252",
};

const hexToString = (hex: string): string => {
  let out = "";
  for (let i = 0; i + 4 <= hex.length; i += 4)
    out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
  return out;
};

/** A ToUnicode CMap's code → text table. */
const parseCMap = (source: string): CMap => {
  const map = new Map<number, string>();
  let wide = false;
  for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of (block[1] ?? "").matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      const src = pair[1] ?? "";
      if (src.length > 2) wide = true;
      map.set(Number.parseInt(src, 16), hexToString(pair[2] ?? ""));
    }
  }
  for (const block of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const range = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]*)>|\[([^\]]*)\])/g;
    for (const entry of (block[1] ?? "").matchAll(range)) {
      const low = Number.parseInt(entry[1] ?? "0", 16);
      const high = Math.min(Number.parseInt(entry[2] ?? "0", 16), low + 65_535);
      if ((entry[1] ?? "").length > 2) wide = true;
      if (entry[4] !== undefined) {
        const base = hexToString(entry[4]);
        const last = base.charCodeAt(base.length - 1);
        for (let code = low; code <= high; code += 1)
          map.set(code, base.slice(0, -1) + String.fromCharCode(last + code - low));
      } else {
        const targets = [...(entry[5] ?? "").matchAll(/<([0-9a-fA-F]*)>/g)];
        targets.forEach((target, i) => map.set(low + i, hexToString(target[1] ?? "")));
      }
    }
  }
  const codespace = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(source);
  if (codespace !== null) wide = (codespace[1] ?? "").length > 2;
  return { bytes: wide ? 2 : 1, map };
};

/** Font resource names (/F1) → their ToUnicode map, across the document. */
const fontMaps = (objects: Map<number, PdfObject>): Map<string, CMap> => {
  const byObject = new Map<number, CMap>();
  for (const [num, object] of objects) {
    const ref = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(object.dict);
    const cmap = ref === null ? undefined : objects.get(Number(ref[1]))?.stream;
    const named = /\/Encoding\s*\/(MacRomanEncoding|WinAnsiEncoding)/.exec(object.dict)?.[1];
    const encoding = named === undefined ? undefined : new TextDecoder(NAMED_ENCODINGS[named]);
    if (cmap !== undefined)
      byObject.set(num, {
        ...parseCMap(cmap.toString("latin1")),
        ...(encoding !== undefined ? { encoding } : {}),
      });
    else if (encoding !== undefined) byObject.set(num, { bytes: 1, map: new Map(), encoding });
  }
  const names = new Map<string, CMap>();
  const addPairs = (text: string): void => {
    for (const pair of text.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      const cmap = byObject.get(Number(pair[2]));
      if (cmap !== undefined && !names.has(pair[1] ?? "")) names.set(pair[1] ?? "", cmap);
    }
  };
  for (const object of objects.values()) {
    for (const inline of object.dict.matchAll(/\/Font\s*<<([\s\S]*?)>>/g))
      addPairs(inline[1] ?? "");
    const indirect = /\/Font\s+(\d+)\s+\d+\s+R/.exec(object.dict);
    if (indirect !== null) addPairs(objects.get(Number(indirect[1]))?.dict ?? "");
  }
  return names;
};

/** A literal (string) operand's bytes, escapes resolved. */
const literalBytes = (source: string, from: number): { bytes: number[]; end: number } => {
  const bytes: number[] = [];
  let depth = 1;
  let i = from;
  while (i < source.length && depth > 0) {
    const char = source[i] ?? "";
    if (char === "\\") {
      const next = source[i + 1] ?? "";
      const escapes: Record<string, number> = {
        n: 10,
        r: 13,
        t: 9,
        b: 8,
        f: 12,
        "(": 40,
        ")": 41,
        "\\": 92,
      };
      if (escapes[next] !== undefined) {
        bytes.push(escapes[next]);
        i += 2;
      } else if (/[0-7]/.test(next)) {
        const octal = /^[0-7]{1,3}/.exec(source.slice(i + 1, i + 4))?.[0] ?? "0";
        bytes.push(Number.parseInt(octal, 8) & 0xff);
        i += 1 + octal.length;
      } else {
        i += next === "\r" && source[i + 2] === "\n" ? 3 : 2;
      }
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth > 0) bytes.push(char.charCodeAt(0));
    i += 1;
  }
  return { bytes, end: i };
};

const decodeBytes = (bytes: readonly number[], cmap: CMap | undefined): string => {
  if (cmap === undefined) return String.fromCharCode(...bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i += cmap.bytes) {
    const code = cmap.bytes === 2 ? ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0) : (bytes[i] ?? 0);
    out +=
      cmap.map.get(code) ??
      (cmap.bytes === 2
        ? ""
        : cmap.encoding !== undefined
          ? cmap.encoding.decode(new Uint8Array([code]))
          : String.fromCharCode(code));
  }
  return out;
};

/** The text a content stream draws, in drawing order. */
const contentText = (source: string, fonts: Map<string, CMap>): string => {
  let out = "";
  let font: CMap | undefined;
  const operands: string[] = [];
  const numbers: number[] = [];
  let pendingName: string | undefined;
  let lineY: number | undefined;
  const lineBreak = (): void => {
    if (out !== "" && !out.endsWith("\n")) out += "\n";
  };
  let i = 0;
  while (i < source.length) {
    const char = source[i] ?? "";
    if (char === "(") {
      const literal = literalBytes(source, i + 1);
      operands.push(decodeBytes(literal.bytes, font));
      i = literal.end;
      continue;
    }
    if (char === "<" && source[i + 1] !== "<") {
      const end = source.indexOf(">", i);
      const hex = source.slice(i + 1, end < 0 ? source.length : end).replace(/\s+/g, "");
      const bytes: number[] = [];
      for (let h = 0; h < hex.length; h += 2)
        bytes.push(Number.parseInt(hex.slice(h, h + 2).padEnd(2, "0"), 16));
      operands.push(decodeBytes(bytes, font));
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (char === "[" || char === "]") {
      i += 1;
      continue;
    }
    if (char === "/") {
      const name = /^\/([^\s/<>[\]()]+)/.exec(source.slice(i, i + 128));
      pendingName = name?.[1];
      i += name?.[0].length ?? 1;
      continue;
    }
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    const word = /^[^\s/<>[\]()]+/.exec(source.slice(i, i + 64))?.[0] ?? char;
    i += word.length;
    if (/^[-+.\d]/.test(word)) {
      // A big negative TJ kerning gap reads as a space between words.
      if (operands.length > 0 && Number(word) < -200) operands.push(" ");
      numbers.push(Number(word));
      continue;
    }
    switch (word) {
      case "Tf":
        font = pendingName === undefined ? undefined : fonts.get(pendingName);
        break;
      case "Tj":
      case "TJ":
        out += operands.join("");
        break;
      case "'":
      case '"':
        lineBreak();
        out += operands.join("");
        break;
      case "Td":
      case "TD":
        // A move along the same line (a font switch mid-sentence) is no break.
        if ((numbers[numbers.length - 1] ?? 0) !== 0) lineBreak();
        break;
      case "Tm": {
        const y = numbers[numbers.length - 1];
        if (lineY !== undefined && y !== lineY) lineBreak();
        lineY = y;
        break;
      }
      case "T*":
        lineBreak();
        break;
      default:
        break;
    }
    operands.length = 0;
    numbers.length = 0;
  }
  return out;
};

export const pdfText = (pdf: Buffer): string => {
  if (/\/Encrypt\s/.test(pdf.toString("latin1", Math.max(0, pdf.length - 4096))))
    throw new Error("the PDF is encrypted");
  const objects = pdfObjects(pdf);
  const fonts = fontMaps(objects);
  let out = "";
  for (const object of objects.values()) {
    if (object.stream === undefined || object.stream.length === 0) continue;
    if (
      /\/Subtype\s*\/(Image|Form|Type1C|CIDFontType0C|OpenType)|\/Length1|\/Type\s*\/(XRef|ObjStm|Metadata)/.test(
        object.dict,
      )
    )
      continue;
    const source = object.stream.toString("latin1");
    if (!/\bBT\b/.test(source) || source.includes("begincmap")) continue;
    out += `${contentText(source, fonts)}\n`;
    if (out.length > MAX_TEXT_CHARS) break;
  }
  return out;
};
