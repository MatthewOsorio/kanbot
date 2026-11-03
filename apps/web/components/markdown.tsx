import ReactMarkdown from "react-markdown";

/** The one Markdown renderer (descriptions, comments, artifacts). react-markdown never renders raw HTML. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md text-sm">
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  );
}
