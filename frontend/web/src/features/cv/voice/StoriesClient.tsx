"use client";

import { useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  Loader2,
  Pencil,
  RefreshCw,
  X,
  Check,
  BookOpen,
} from "lucide-react";
import { Button } from "@/ui";

// ── Types ─────────────────────────────────────────────────────────────────────

interface StoryNumber {
  metric: string;
  value:  string;
}

export interface StoredStory {
  id:                   string;
  title:                string;
  domain:               string;
  year:                 number | null;
  one_line:             string;
  detailed:             string;
  numbers:              StoryNumber[];
  tags:                 string[];
  extraction_timestamp: string;
}

interface Props {
  initialStories: StoredStory[];
}

// ── StoryCard ─────────────────────────────────────────────────────────────────

function StoryCard({
  story,
  expanded,
  onToggleExpand,
  editing,
  pendingTags,
  saving,
  onEditStart,
  onEditCancel,
  onPendingTagsChange,
  onSaveTags,
  tagError,
}: {
  story:               StoredStory;
  expanded:            boolean;
  onToggleExpand:      () => void;
  editing:             boolean;
  pendingTags:         string;
  saving:              boolean;
  onEditStart:         () => void;
  onEditCancel:        () => void;
  onPendingTagsChange: (v: string) => void;
  onSaveTags:          () => void;
  tagError:            string | null;
}) {
  return (
    <li className="rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] p-4 space-y-3">

      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold text-[var(--text)] leading-snug">{story.title}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-[var(--surface-2)] text-[var(--text-2)] border border-[var(--card-border)]">
              {story.domain}
            </span>
            {story.year && (
              <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-[var(--surface-2)] text-[var(--text-3)] border border-[var(--card-border)]">
                {story.year}
              </span>
            )}
          </div>
        </div>
        <Button
          variant="default"
          size="sm"
          onClick={onToggleExpand}
          className="shrink-0 p-1 rounded hover:bg-[var(--surface-2)] text-[var(--sidebar-text-dim)] transition-colors"
          title={expanded ? "Collapse" : "Expand"}
        >
          <ChevronDown className={`w-4 h-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </Button>
      </div>

      {/* One-line summary */}
      <p className="text-sm text-[var(--text-2)] leading-relaxed">{story.one_line}</p>

      {/* Numbers pills */}
      {story.numbers.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {story.numbers.map((n, i) => (
            <span
              key={i}
              className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200"
            >
              {n.metric}: {n.value}
            </span>
          ))}
        </div>
      )}

      {/* Tags */}
      <div className="space-y-1.5">
        {editing ? (
          <div className="space-y-2">
            <input
              type="text"
              value={pendingTags}
              onChange={(e) => onPendingTagsChange(e.target.value)}
              placeholder="leadership, technical, delivery…"
              className="w-full rounded-lg border border-[var(--input-border)] bg-[var(--input-bg)] px-3 py-1.5 text-xs text-black placeholder:text-[var(--sidebar-text-dim)] focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
            />
            {tagError && (
              <p className="text-[11px] text-red-600">{tagError}</p>
            )}
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={onSaveTags}
                disabled={saving}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--brand)] text-[var(--brand-fg)] text-xs font-semibold disabled:opacity-50 transition-opacity"
              >
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                Save
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={onEditCancel}
                disabled={saving}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--card-border)] text-xs text-[var(--text-2)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-50"
              >
                <X className="w-3 h-3" />
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {story.tags.length > 0
              ? story.tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-2 py-0.5 rounded-full text-[11px] bg-[var(--surface-2)] text-[var(--text-2)] border border-[var(--card-border)]"
                  >
                    {tag}
                  </span>
                ))
              : <span className="text-[11px] text-[var(--sidebar-text-dim)] italic">No tags</span>
            }
            <Button
              variant="default"
              size="sm"
              onClick={onEditStart}
              className="p-0.5 rounded text-[var(--sidebar-text-dim)] hover:text-[var(--text)] transition-colors"
              title="Edit tags"
            >
              <Pencil className="w-3 h-3" />
            </Button>
          </div>
        )}
      </div>

      {/* Expanded: detailed paragraph */}
      {expanded && (
        <div className="border-t border-[var(--card-border)] pt-3">
          <p className="text-xs text-[var(--text-2)] leading-relaxed whitespace-pre-wrap">
            {story.detailed}
          </p>
        </div>
      )}
    </li>
  );
}

// ── StoriesClient ─────────────────────────────────────────────────────────────

export function StoriesClient({ initialStories }: Props) {
  const [stories,     setStories]     = useState<StoredStory[]>(initialStories);
  const [extracting,  setExtracting]  = useState(false);
  const [extractErr,  setExtractErr]  = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [editingId,   setEditingId]   = useState<string | null>(null);
  const [pendingTags, setPendingTags] = useState("");
  const [savingId,    setSavingId]    = useState<string | null>(null);
  const [tagError,    setTagError]    = useState<string | null>(null);

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function startEdit(story: StoredStory) {
    setEditingId(story.id);
    setPendingTags(story.tags.join(", "));
    setTagError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setPendingTags("");
    setTagError(null);
  }

  async function saveTags(storyId: string) {
    const tags = pendingTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    setSavingId(storyId);
    setTagError(null);

    try {
      const res = await fetch(`/api/user/stories/${storyId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ tags }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTagError((data as { error?: string }).error ?? "Failed to save tags.");
        return;
      }
      setStories((prev) =>
        prev.map((s) => s.id === storyId ? { ...s, tags: (data as StoredStory).tags } : s)
      );
      setEditingId(null);
      setPendingTags("");
    } catch {
      setTagError("Network error. Please try again.");
    } finally {
      setSavingId(null);
    }
  }

  async function handleReExtract() {
    setExtracting(true);
    setExtractErr(null);

    try {
      const res  = await fetch("/api/user/stories/extract", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        setExtractErr((data as { error?: string }).error ?? "Extraction failed. Please try again.");
        return;
      }
      setStories((data as { stories: StoredStory[] }).stories ?? []);
      setExpandedIds(new Set());
      setEditingId(null);
    } catch {
      setExtractErr("Network error. Please try again.");
    } finally {
      setExtracting(false);
    }
  }

  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-[var(--brand)]" />
          <span className="text-sm font-semibold text-[var(--text)]">
            {stories.length > 0
              ? `${stories.length} achievement ${stories.length === 1 ? "story" : "stories"}`
              : "No stories yet"}
          </span>
        </div>
        <Button
          variant="default"
          size="sm"
          onClick={handleReExtract}
          disabled={extracting}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--card-border)] text-xs font-semibold text-[var(--text-2)] hover:bg-[var(--surface-2)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {extracting
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <RefreshCw className="w-3.5 h-3.5" />}
          {extracting ? "Extracting… (up to 90s)" : "Re-extract from CV"}
        </Button>
      </div>

      {/* Extraction error */}
      {extractErr && (
        <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{extractErr}</span>
        </div>
      )}

      {/* Empty state */}
      {stories.length === 0 && !extracting && (
        <div className="rounded-xl border border-dashed border-[var(--card-border)] bg-[var(--card-bg)] p-6 text-center space-y-2">
          <p className="text-sm font-medium text-[var(--text)]">No stories extracted yet</p>
          <p className="text-xs text-[var(--sidebar-text-dim)]">
            Click &quot;Re-extract from CV&quot; to pull achievement stories from your active CV.
            These will be used to personalise your cover letters.
          </p>
        </div>
      )}

      {/* Story list */}
      {stories.length > 0 && (
        <ul className="space-y-3">
          {stories.map((story) => (
            <StoryCard
              key={story.id}
              story={story}
              expanded={expandedIds.has(story.id)}
              onToggleExpand={() => toggleExpand(story.id)}
              editing={editingId === story.id}
              pendingTags={editingId === story.id ? pendingTags : ""}
              saving={savingId === story.id}
              onEditStart={() => startEdit(story)}
              onEditCancel={cancelEdit}
              onPendingTagsChange={setPendingTags}
              onSaveTags={() => saveTags(story.id)}
              tagError={editingId === story.id ? tagError : null}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
