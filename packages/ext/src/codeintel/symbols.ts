/**
 * Symbol extraction over a parsed tree: definitions per language from one
 * per-language table (node type → kind), plus identifier references that
 * never descend into string or comment nodes (node types distinguish them,
 * so no regex). Lines are 1-based everywhere.
 */
import type { Node, Tree } from "web-tree-sitter";

export type SymbolKind = "function" | "method" | "class" | "const" | "type" | "interface";

export interface Symbol {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly line: number;
  readonly endLine: number;
}

export interface Reference {
  readonly line: number;
  readonly column: number;
  readonly excerpt: string;
}

interface LanguageTable {
  /** Node type → symbol kind, for declarations that carry a `name` field. */
  readonly declarations: Record<string, SymbolKind>;
  /** Declarator wrappers whose function-valued bindings become `const`. */
  readonly bindingTypes: readonly string[];
  /** Nodes that open a class scope (their inner defs become methods). */
  readonly classScopes: readonly string[];
  /** Reference walk: node types whose subtree is never code. */
  readonly opaque: readonly string[];
  /** Node types counted as identifier references. */
  readonly identifiers: readonly string[];
}

const EXCERPT_CHARS = 120;

const cLike: LanguageTable = {
  declarations: {
    function_declaration: "function",
    generator_function_declaration: "function",
    class_declaration: "class",
    abstract_class_declaration: "class",
    method_definition: "method",
    type_alias_declaration: "type",
    interface_declaration: "interface",
  },
  bindingTypes: ["lexical_declaration", "variable_declaration"],
  classScopes: ["class_body"],
  opaque: ["string", "template_string", "comment", "regex"],
  identifiers: ["identifier", "property_identifier", "shorthand_property_identifier"],
};

const python: LanguageTable = {
  declarations: { function_definition: "function", class_definition: "class" },
  bindingTypes: [],
  classScopes: ["class_definition"],
  opaque: ["string", "comment"],
  identifiers: ["identifier"],
};

const tableOf = (language: string): LanguageTable | undefined =>
  language === "python" ? python : cLike;

const nameOf = (node: Node): string | undefined => node.childForFieldName("name")?.text;

const isFunctionValue = (declarator: Node): boolean => {
  const value = declarator.childForFieldName("value");
  if (value === null) return false;
  return (
    value.type === "arrow_function" || value.type === "function" || value.type.endsWith("_function")
  );
};

/** Definition symbols in a parsed tree, in source order. */
export const symbolsOf = (tree: Tree, language: string): Symbol[] => {
  const table = tableOf(language);
  if (table === undefined) return [];
  const found: Symbol[] = [];
  const visit = (node: Node, inClass: boolean): void => {
    let kind = table.declarations[node.type];
    if (kind !== undefined) {
      const name = nameOf(node);
      if (name !== undefined && name !== "") {
        if (inClass && kind === "function") kind = "method";
        found.push({
          name,
          kind,
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
      }
    } else if (table.bindingTypes.includes(node.type)) {
      for (let i = 0; i < node.childCount; i += 1) {
        const declarator = node.child(i);
        if (declarator === null || declarator.type !== "variable_declarator") continue;
        const name = nameOf(declarator);
        if (name !== undefined && name !== "" && isFunctionValue(declarator)) {
          found.push({
            name,
            kind: "const",
            line: declarator.startPosition.row + 1,
            endLine: declarator.endPosition.row + 1,
          });
        }
      }
    }
    const nextInClass = inClass || table.classScopes.includes(node.type);
    for (let i = 0; i < node.childCount; i += 1) {
      const child = node.child(i);
      if (child !== null) visit(child, nextInClass);
    }
  };
  visit(tree.rootNode, false);
  return found.sort((a, b) => a.line - b.line);
};

/** Identifier occurrences of a name, excluding strings and comments, with excerpts. */
export const findReferences = (tree: Tree, language: string, name: string): Reference[] => {
  const table = tableOf(language);
  if (table === undefined) return [];
  const lines = tree.rootNode.text.split("\n");
  const excerpt = (line: number): string => {
    const raw = lines[line - 1] ?? "";
    const trimmed = raw.trim();
    return trimmed.length > EXCERPT_CHARS ? `${trimmed.slice(0, EXCERPT_CHARS)}…` : trimmed;
  };
  const found: Reference[] = [];
  const visit = (node: Node): void => {
    if (table.opaque.includes(node.type)) return;
    if (table.identifiers.includes(node.type) && node.text === name) {
      found.push({
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        excerpt: excerpt(node.startPosition.row + 1),
      });
    }
    for (let i = 0; i < node.childCount; i += 1) {
      const child = node.child(i);
      if (child !== null) visit(child);
    }
  };
  visit(tree.rootNode);
  return found;
};
