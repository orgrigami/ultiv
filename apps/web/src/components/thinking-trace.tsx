/**
 * Reasoning as a collapsed Trace step: "Thinking…" while live, then past
 * tense. One component for the chat transcript and the task timeline, so
 * both read the same.
 */
import { memo } from "react";
import { BrainIcon } from "lucide-react";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";

export const ThinkingTrace = memo(function ThinkingTrace({
  text,
  live,
}: {
  text: string;
  live: boolean;
}) {
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine {...(live ? { status: "running" as const } : {})}>
            <TraceIcon>
              <BrainIcon />
            </TraceIcon>
            <TraceTitle>{live ? "Thinking…" : "Thought for a moment"}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="ml-6 pl-3">
          <p className="text-muted-foreground max-w-prose text-sm whitespace-pre-wrap">{text}</p>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
});
