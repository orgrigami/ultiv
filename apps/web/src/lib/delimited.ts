/**
 * CSV/TSV for the file preview: a quoted parse (malformed tails stay as
 * found), the delimiter from the file name, and which columns read as
 * numbers so the table can right-align them.
 */

/** Rows of fields; `""` escapes a quote inside a quoted field. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (quoted) {
      if (char === '"' && text[cursor + 1] === '"') {
        field += '"';
        cursor += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Tab for `.tsv`, comma otherwise. */
export const delimiterOf = (name: string): string =>
  name.toLocaleLowerCase("en").endsWith(".tsv") ? "\t" : ",";

const NUMBER = /^[-+]?[$€£¥]?\s?\d[\d,_ ]*(\.\d+)?%?$|^[-+]?\.\d+%?$/;

/** A column is numeric when every non-empty cell is a number (and one exists). */
export function numericColumns(rows: readonly (readonly string[])[], width: number): boolean[] {
  return Array.from({ length: width }, (_, column) => {
    let seen = false;
    for (const row of rows) {
      const cell = (row[column] ?? "").trim();
      if (cell === "") continue;
      if (!NUMBER.test(cell)) return false;
      seen = true;
    }
    return seen;
  });
}

/** Header, capped body and totals for the table view. */
export type TableShape = {
  readonly head: readonly string[];
  readonly body: readonly (readonly string[])[];
  readonly width: number;
  readonly totalRows: number;
  readonly numeric: readonly boolean[];
};

export function tableOf(text: string, name: string, maxRows: number, maxCols: number): TableShape {
  const all = parseDelimited(text, delimiterOf(name));
  // A trailing newline leaves no empty row (the parser stops at it), but a
  // blank line in the middle is one empty field: drop those.
  const rows = all.filter((row) => !(row.length === 1 && row[0] === ""));
  const [first = [], ...rest] = rows;
  const width = Math.min(maxCols, Math.max(first.length, ...rest.map((row) => row.length)));
  const head = Array.from({ length: width }, (_, index) => first[index] ?? "");
  const body = rest.slice(0, maxRows).map((row) => row.slice(0, width));
  return { head, body, width, totalRows: rest.length, numeric: numericColumns(body, width) };
}
