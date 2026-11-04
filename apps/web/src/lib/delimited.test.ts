import { describe, expect, it } from "vite-plus/test";
import { delimiterOf, numericColumns, parseDelimited, tableOf } from "./delimited.ts";

describe("parseDelimited", () => {
  it("keeps quoted commas, escaped quotes and CRLF endings", () => {
    expect(parseDelimited('a,"b, c","say ""hi"""\r\n1,2,3\r\n', ",")).toEqual([
      ["a", "b, c", 'say "hi"'],
      ["1", "2", "3"],
    ]);
  });

  it("keeps a last row with no newline", () => {
    expect(parseDelimited("x\ty\n1\t2", "\t")).toEqual([
      ["x", "y"],
      ["1", "2"],
    ]);
  });
});

describe("delimiterOf", () => {
  it("uses tabs for .tsv only", () => {
    expect(delimiterOf("Data.TSV")).toBe("\t");
    expect(delimiterOf("data.csv")).toBe(",");
  });
});

describe("numericColumns", () => {
  it("marks a column numeric when every filled cell is a number", () => {
    const rows = [
      ["North", "1,200", "$4.50", "12%", ""],
      ["South", "-3", "€0.25", "8%", "n/a"],
      ["East", "", ".5", "100%", ""],
    ];
    expect(numericColumns(rows, 5)).toEqual([false, true, true, true, false]);
  });

  it("never marks an empty column numeric", () => {
    expect(numericColumns([[""], [""]], 1)).toEqual([false]);
  });
});

describe("tableOf", () => {
  it("splits the header, caps rows and columns, and counts every row", () => {
    const text = "a,b,c\n1,2,3\n4,5,6\n\n7,8,9\n";
    const table = tableOf(text, "x.csv", 2, 2);
    expect(table.head).toEqual(["a", "b"]);
    expect(table.body).toEqual([
      ["1", "2"],
      ["4", "5"],
    ]);
    expect(table.totalRows).toBe(3);
    expect(table.numeric).toEqual([true, true]);
  });

  it("pads a short header to the widest row", () => {
    expect(tableOf("a\n1,2\n", "x.csv", 10, 10).head).toEqual(["a", ""]);
  });
});
