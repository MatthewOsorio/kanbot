import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The one Markdown renderer (descriptions, comments, artifacts). react-markdown never renders raw HTML.
 * GFM for the tables, task lists and strikethrough agents write (Testy's test reports are tables).
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
