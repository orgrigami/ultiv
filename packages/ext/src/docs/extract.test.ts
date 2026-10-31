import { describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { deflateRawSync, deflateSync } from "node:zlib";
import { extractDocumentText, MAX_DOCUMENT_BYTES } from "./extract.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

/** A one-entry zip (deflated), enough to stand in for a hand-made document. */
const zipOf = (name: string, content: string): Buffer => {
  const data = deflateRawSync(Buffer.from(content, "utf8"));
  const nameBytes = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const directoryAt = local.length + nameBytes.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(directoryAt, 16);
  return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
};

describe("extract_document_text", () => {
  it("reads a Word document (made by macOS textutil)", () => {
    expect(extractDocumentText(fixture("sample.docx"))).toEqual({
      ok: true,
      kind: "docx",
      text: "Quarterly plan for the test team.\nSecond paragraph with café and 3 < 4 & more.",
    });
  });

  it("reads a PDF (made by macOS Quartz), accents included", () => {
    expect(extractDocumentText(fixture("sample.pdf"))).toEqual({
      ok: true,
      kind: "pdf",
      text: "Quarterly plan for the test team.\nSecond paragraph with café and 3 < 4 & more.",
    });
  });

  it("decodes PDF fonts through their ToUnicode maps", () => {
    expect(extractDocumentText(fixture("sample-unicode.pdf"))).toMatchObject({
      ok: true,
      text: "Mixed script check: 東京 and Ελληνικά, done.",
    });
  });

  it("keeps tables, tabs and breaks in a docx", () => {
    const xml =
      '<w:document><w:body><w:p><w:r><w:t xml:space="preserve">A </w:t><w:tab/><w:t>B</w:t></w:r></w:p>' +
      "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>c1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>c&amp;2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>" +
      "</w:body></w:document>";
    const result = extractDocumentText(zipOf("word/document.xml", xml));
    expect(result).toMatchObject({ ok: true, kind: "docx" });
    expect(result.ok && result.text).toContain("A \tB");
    expect(result.ok && result.text).toContain("c&2");
  });

  it("reads a hand-made PDF content stream with TJ and escapes", () => {
    const content =
      "BT /F1 12 Tf 72 720 Td [(Hello)-300(world) ] TJ 0 -14 Td (Line \\(two\\)) Tj ET";
    const stream = deflateSync(Buffer.from(content, "latin1"));
    const pdf = Buffer.concat([
      Buffer.from(
        `%PDF-1.4\n1 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`,
        "latin1",
      ),
      stream,
      Buffer.from("\nendstream\nendobj\ntrailer\n<< >>\n%%EOF\n", "latin1"),
    ]);
    expect(extractDocumentText(pdf)).toEqual({
      ok: true,
      kind: "pdf",
      text: "Hello world\nLine (two)",
    });
  });

  it("says plainly what it can't read", () => {
    expect(extractDocumentText(Buffer.from("plain text"))).toMatchObject({ ok: false });
    expect(extractDocumentText(zipOf("other.txt", "x"))).toMatchObject({
      ok: false,
      reason: "it's a zip file, but not a Word document",
    });
    const empty = Buffer.from("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n", "latin1");
    expect(extractDocumentText(empty)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no OCR"),
    });
    expect(extractDocumentText(Buffer.alloc(MAX_DOCUMENT_BYTES + 1))).toMatchObject({ ok: false });
    expect(extractDocumentText(Buffer.from("PK\u0003\u0004broken", "latin1"))).toMatchObject({
      ok: false,
    });
  });
});
