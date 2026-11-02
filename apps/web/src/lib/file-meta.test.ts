import { describe, expect, it } from "vite-plus/test";
import {
  artifactLinkOf,
  formatBytes,
  kindLabel,
  langOf,
  liftArtifactLinks,
  parseWrittenArtifact,
  previewKindOf,
} from "./file-meta.ts";

describe("previewKindOf", () => {
  it("sorts every mime class", () => {
    expect(previewKindOf("image/png", "p.png")).toBe("image");
    expect(previewKindOf("application/pdf", "p.pdf")).toBe("pdf");
    expect(previewKindOf("audio/mpeg", "a.mp3")).toBe("audio");
    expect(previewKindOf("video/mp4", "v.mp4")).toBe("video");
    expect(previewKindOf("text/markdown", "r.md")).toBe("markdown");
    expect(previewKindOf("application/json", "d.json")).toBe("text");
    expect(previewKindOf("application/octet-stream", "d.py")).toBe("text");
    expect(previewKindOf(undefined, "d.py")).toBe("text");
    expect(previewKindOf("application/octet-stream", "blob")).toBe("none");
    expect(previewKindOf(undefined, "blob")).toBe("none");
  });

  it("never previews html or svg inline", () => {
    expect(previewKindOf("text/html", "p.html")).toBe("blocked");
    expect(previewKindOf("image/svg+xml", "d.svg")).toBe("blocked");
    expect(previewKindOf("application/xhtml+xml", "p.xhtml")).toBe("blocked");
  });
});

describe("kindLabel", () => {
  it("labels known mimes, then media prefixes, then the extension", () => {
    expect(kindLabel("text/markdown", "r.md")).toBe("Markdown");
    expect(kindLabel("image/png", "p.png")).toBe("Image");
    expect(kindLabel("audio/mpeg", "a.mp3")).toBe("Audio");
    expect(kindLabel("video/mp4", "v.mp4")).toBe("Video");
    expect(kindLabel(undefined, "d.py")).toBe("PY");
    expect(kindLabel(undefined, "noext")).toBe("File");
  });
});

describe("formatBytes", () => {
  it("scales to human units", () => {
    expect(formatBytes(5)).toBe("5 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1_048_576)).toBe("3.0 MB");
  });
});

describe("langOf", () => {
  it("maps extensions to bundled shiki langs and falls back to plain", () => {
    expect(langOf("a.ts")).toBe("typescript");
    expect(langOf("b.MD")).toBe("markdown");
    expect(langOf("c.unknownext")).toBe("");
    expect(langOf("nodot")).toBe("");
  });
});

describe("artifactLinkOf", () => {
  it("accepts relative and absolute links to an artifact, any host", () => {
    expect(artifactLinkOf("/api/artifacts/abc123")).toEqual({ id: "abc123", name: "abc123" });
    expect(artifactLinkOf("http://127.0.0.1:8787/api/artifacts/abc123")).toEqual({
      id: "abc123",
      name: "abc123",
    });
    expect(artifactLinkOf("https://mac.ts.net/api/artifacts/vfs-index")).toEqual({
      id: "vfs-index",
      name: "vfs-index",
    });
  });

  it("rejects non-artifact paths and malformed ids", () => {
    expect(artifactLinkOf("/api/sessions/x")).toBeNull();
    expect(artifactLinkOf("/api/artifacts/")).toBeNull();
    expect(artifactLinkOf("/api/artifacts/../escape")).toBeNull();
    expect(artifactLinkOf("/api/artifacts/a/b")).toBeNull();
    expect(artifactLinkOf("")).toBeNull();
    expect(artifactLinkOf("http://x")).toBeNull();
  });
});

describe("parseWrittenArtifact", () => {
  it("reads id and name from a legacy artifact_write output", () => {
    const output = "artifact a1b2 (report.md) in your workspace; your owner can open it in the app";
    expect(parseWrittenArtifact(output)).toEqual({ id: "a1b2", name: "report.md" });
  });

  it("rejects non-matching or path-shaped ids", () => {
    expect(parseWrittenArtifact("saved it")).toBeNull();
    expect(parseWrittenArtifact("artifact ../etc/passwd (x) in your workspace")).toBeNull();
    expect(parseWrittenArtifact("artifact (name) in your workspace")).toBeNull();
  });
});

describe("liftArtifactLinks", () => {
  it("lifts bare paths into markdown links, one per id", () => {
    expect(liftArtifactLinks("Links: /api/artifacts/abc123 and /api/artifacts/def456")).toBe(
      "Links: [abc123](/api/artifacts/abc123) and [def456](/api/artifacts/def456)",
    );
  });

  it("leaves anchor destinations, angle destinations and larger URLs alone", () => {
    expect(liftArtifactLinks("[report](/api/artifacts/abc123) is ready")).toBe(
      "[report](/api/artifacts/abc123) is ready",
    );
    expect(liftArtifactLinks("[r](</api/artifacts/abc123>)")).toBe("[r](</api/artifacts/abc123>)");
    expect(liftArtifactLinks("see https://mac.ts.net/api/artifacts/abc123")).toBe(
      "see https://mac.ts.net/api/artifacts/abc123",
    );
    expect(liftArtifactLinks("fetch /api/artifacts/abc123/meta")).toBe(
      "fetch /api/artifacts/abc123/meta",
    );
  });

  it("keeps code spans and fenced code blocks as code", () => {
    expect(liftArtifactLinks("path is `/api/artifacts/abc123` in the api")).toBe(
      "path is `/api/artifacts/abc123` in the api",
    );
    expect(liftArtifactLinks("```\ncurl /api/artifacts/abc123\n```")).toBe(
      "```\ncurl /api/artifacts/abc123\n```",
    );
  });

  it("lifts across a real bot reply shape", () => {
    const reply =
      "The screenshots are now in this chat as download cards:\n\n" +
      "- **todo-app-light.png** (`76dc58e8`)\n" +
      "- **todo-app-dark.png** (`661207a6`)\n\n" +
      "Links: /api/artifacts/76dc58e8-c1fa-4458-903a-20be42467938 and /api/artifacts/661207a6-dcca-4c2c-b581-886665bf1752";
    expect(liftArtifactLinks(reply)).toContain(
      "[76dc58e8-c1fa-4458-903a-20be42467938](/api/artifacts/76dc58e8-c1fa-4458-903a-20be42467938)",
    );
  });
});
