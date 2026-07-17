"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  markdown: string;
}

export function RecommendationsCard({ markdown }: Props) {
  if (!markdown?.trim()) return null;
  return (
    <div className="bg-surface border border-border rounded-md overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-surface-2">
        <h2 className="text-[14px] font-semibold text-text">AI recommendations</h2>
        <p className="text-[12px] text-text-3 mt-0.5">
          Concrete suggestions to strengthen your CV for this specific role.
        </p>
      </div>
      <div className="px-5 py-4 prose prose-sm max-w-none text-text-2 leading-relaxed
                      prose-headings:text-text prose-headings:font-semibold
                      prose-strong:text-text prose-a:text-[var(--brand)]
                      prose-li:my-0.5">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>
    </div>
  );
}
