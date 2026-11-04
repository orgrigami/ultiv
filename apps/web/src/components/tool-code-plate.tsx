/**
 * Highlighted code in the receipt style every tool body shares: a small
 * titled plate, bounded height, optional copy. Shared by the shaped bodies
 * (tool-bodies.tsx) and the generic receipts (tool-receipts.tsx).
 */
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { cn } from "@/lib/utils";

/** Highlighted code in the receipt style every body shares. */
export function CodePlate({
  title,
  code,
  lang,
  icon,
  wrap = false,
  maxH = "max-h-72",
  copy = false,
}: {
  title: string;
  code: string;
  lang: string;
  icon?: React.ReactNode;
  wrap?: boolean;
  maxH?: string;
  copy?: boolean;
}) {
  const lines = useHighlightedCode(code, lang);
  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        {icon}
        <CodeBlockTitle>{title}</CodeBlockTitle>
        {copy && (
          <CodeBlockActions>
            <CodeBlockCopyButton value={code} />
          </CodeBlockActions>
        )}
      </CodeBlockHeader>
      <CodeBlockContent wrap={wrap} className={cn(maxH, "overflow-y-auto")}>
        {lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines only append
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}
