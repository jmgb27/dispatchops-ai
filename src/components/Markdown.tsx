"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders model output as Markdown.
 *
 * The agent writes Markdown whether or not anyone asked it to — comparison
 * tables, bold conclusions, bulleted eliminations. Printed as plain text those
 * arrive as `| Resource | Feasible? |` and `**Yes**`, which is worse than
 * useless on the one screen a dispatcher is supposed to read quickly.
 *
 * Security note, because this is not ordinary Markdown rendering: the text is
 * LLM output, and the LLM's context includes dispatch notes that are explicitly
 * untrusted — the injection demo plants instructions in exactly that field. So
 * anything reaching here is attacker-influenced by design.
 *
 *   - Raw HTML is NOT enabled. `react-markdown` escapes it unless `rehype-raw`
 *     is added, and it is deliberately not added. That is the whole XSS story.
 *   - Images are dropped. A Markdown image is an outbound request to a URL the
 *     model chose, which leaks that the console was opened and to whom.
 *   - Links keep react-markdown's default protocol filtering and are marked
 *     `noopener noreferrer`, so a planted link cannot reach `window.opener`.
 *
 * The guardrail this project is about stops the agent spending money. It does
 * nothing about the agent's prose, and prose is rendered in a browser.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed text-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        disallowedElements={["img"]}
        unwrapDisallowed
        components={{
          p: ({ children }) => <p className="leading-relaxed">{children}</p>,

          strong: ({ children }) => (
            <strong className="font-semibold text-text">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,

          ul: ({ children }) => (
            <ul className="ml-4 list-disc space-y-1 marker:text-muted">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="ml-4 list-decimal space-y-1 marker:text-muted">
              {children}
            </ol>
          ),

          // Tables are the reason this component exists. They must never widen
          // the page — the console is a two-column layout on desktop and the
          // trace panel is the narrow one.
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto rounded-lg border border-line">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-panel-2 text-muted">{children}</thead>
          ),
          tr: ({ children }) => (
            <tr className="border-b border-line/70 last:border-0">{children}</tr>
          ),
          th: ({ children }) => (
            <th className="px-2.5 py-1.5 text-left font-semibold whitespace-nowrap">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-2.5 py-1.5 align-top">{children}</td>
          ),

          code: ({ children }) => (
            <code className="rounded bg-ink/60 px-1 py-0.5 font-mono text-[11px]">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-md border border-line bg-ink/60 p-2 font-mono text-[11px] leading-relaxed">
              {children}
            </pre>
          ),

          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-line pl-3 text-muted">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-line" />,

          // Headings inside a timeline entry are noise; flatten them to bold.
          h1: ({ children }) => (
            <p className="font-semibold text-text">{children}</p>
          ),
          h2: ({ children }) => (
            <p className="font-semibold text-text">{children}</p>
          ),
          h3: ({ children }) => (
            <p className="font-semibold text-text">{children}</p>
          ),

          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-accent underline underline-offset-2"
            >
              {children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
