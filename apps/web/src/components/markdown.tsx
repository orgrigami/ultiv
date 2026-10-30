/**
 * Chat markdown (GFM). Fenced code renders as a CodeBlock with a copy button,
 * highlighted by shiki once its language has loaded (plain text until then,
 * and for languages we don't ship). A link to an artifact renders as a file
 * card — the bot's way of handing the owner a file mid-reply.
 */
import { isValidElement, memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileCard } from "@/components/file-card";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import { artifactLinkOf } from "@/lib/file-meta";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";

function FencedCode({ code, language }: { code: string; language: string }) {
  const lines = useHighlightedCode(code, language);
  return (
    <CodeBlock size="sm" className="not-prose my-2">
      <CodeBlockHeader>
        <CodeBlockTitle>{language === "" ? "code" : language}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={code} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent>
        {lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines only append
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

const components: Components = {
  pre: ({ children }) => {
    const child = Array.isArray(children) ? children[0] : children;
    if (!isValidElement(child)) return <pre>{children}</pre>;
    const props = child.props as { className?: string; children?: unknown };
    const language = /language-(\S+)/.exec(props.className ?? "")?.[1] ?? "";
    const code = typeof props.children === "string" ? props.children : String(props.children ?? "");
    return <FencedCode code={code.replace(/\n$/, "")} language={language} />;
  },
  a: ({ href, children }) => {
    const file = artifactLinkOf(href ?? "");
    if (file === null) {
      return <a href={href}>{children}</a>;
    }
    const text = typeof children === "string" ? children.trim() : "";
    return <FileCard file={{ id: file.id, name: text !== "" ? text : file.name }} />;
  },
};

function MarkdownImpl({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
}

/** Re-parses only when its text changes. */
export const Markdown = memo(MarkdownImpl);
export default Markdown;
