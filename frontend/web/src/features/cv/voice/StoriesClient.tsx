"use client";

import { useEffect, useRef, useState } from "react";
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
import { Input, Button, IconButton } from "@/components/ui";
import type { StoryNumber } from "@/lib/types";

// ── Types ─────────────────────────────────────────────────────────────────────

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
            <span className="px-2 py-0.5 rounded-full text-caption font-medium bg-[var(--surface-2)] text-[var(--text-2)] border border-[var(--card-border)]">
              {story.domain}
            </span>
            {story.year && (
              <span className="px-2 py-0.5 rounded-full text-caption font-medium bg-[var(--surface-2)] text-[var(--text-3)] border border-[var(--card-border)]">
                {story.year}
              </span>
            )}
          </div>
        </div>
        <IconButton
          onClick={onToggleExpand}
          size="sm"
          title={expanded ? "Collapse" : "Expand"}
          aria-label={expanded ? "Collapse" : "Expand"}
          icon={<ChevronDown className={`w-4 h-4 transition-transform ${expanded ? "rotate-180" : ""}`} />}
        />
      </div>

      {/* One-line summary */}
      <p className="text-sm text-[var(--text-2)] leading-relaxed">{story.one_line}</p>

      {/* Numbers pills */}
      {story.numbers.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {story.numbers.map((n, i) => (
            <span
              key={i}
              className="px-2 py-0.5 rounded-full text-caption font-medium bg-emerald-50 text-emerald-700 border border-emerald-200"
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
            <Input
              type="text"
              value={pendingTags}
              onChange={(e) => onPendingTagsChange(e.target.value)}
              placeholder="leadership, technical, delivery…"
              error={tagError ?? undefined}
              aria-label="Tags"
            />
            <div className="flex items-center gap-2">
              <Button variant="brand" size="xs" onClick={onSaveTags} disabled={saving}>
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                Save
              </Button>
              <button onClick={onEditCancel} disabled={saving} className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--card-border)] text-xs text-[var(--text-2)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-50">
                <X className="w-3 h-3" />
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {story.tags.length > 0
              ? story.tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-2 py-0.5 rounded-full text-caption bg-[var(--surface-2)] text-[var(--text-2)] border border-[var(--card-border)]"
                  >
                    {tag}
                  </span>
                ))
              : <span className="text-caption text-[var(--sidebar-text-dim)] italic">No tags</span>
            }
            <button onClick={onEditStart} className="p-0.5 rounded text-[var(--sidebar-text-dim)] hover:text-[var(--text)] transition-colors" title="Edit tags">
              <Pencil className="w-3 h-3" />
            </button>
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
  // Zero-story extractions return HTTP 200 with a `diagnostic` explaining why
  // (e.g. no quantified achievements on the CV). Must be surfaced — silently
  // showing "No stories yet" again reads as the button doing nothing.
  const [diagnostic,  setDiagnostic]  = useState<string | null>(null);
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

  // Self-heal: upload-time extraction is best-effort (it can die on a
  // serverless freeze or transient AI error) — when the page opens with zero
  // stories, run extraction once per session automatically instead of making
  // the user discover the Re-extract button. Silent on failure (e.g. no CV
  // uploaded yet): the user didn't ask, so no scary error banner.
  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current || stories.length > 0 || extracting) return;
    if (sessionStorage.getItem("jt_stories_autoextract") === "1") return;
    sessionStorage.setItem("jt_stories_autoextract", "1");
    autoTried.current = true;
    void handleReExtract({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only heal
  }, []);

  async function handleReExtract(opts?: { silent?: boolean }) {
    setExtracting(true);
    setExtractErr(null);
    setDiagnostic(null);

    try {
      const res  = await fetch("/api/user/stories/extract", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        if (!opts?.silent) {
          setExtractErr((data as { error?: string }).error ?? "Extraction failed. Please try again.");
        }
        return;
      }
      const payload = data as { stories: StoredStory[]; diagnostic?: string | null };
      setStories(payload.stories ?? []);
      if ((payload.stories ?? []).length === 0) {
        setDiagnostic(
          payload.diagnostic
            ?? "Extraction ran but found no achievement stories on your CV. Stories need concrete outcomes — try adding bullets with numbers or results, then re-extract.",
        );
      }
      setExpandedIds(new Set());
      setEditingId(null);
    } catch {
      if (!opts?.silent) setExtractErr("Network error. Please try again.");
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
        <button onClick={() => handleReExtract()} disabled={extracting} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--card-border)] text-xs font-semibold text-[var(--text-2)] hover:bg-[var(--surface-2)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
          {extracting
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <RefreshCw className="w-3.5 h-3.5" />}
          {extracting ? "Extracting… (up to 90s)" : "Re-extract from CV"}
        </button>
      </div>

      {/* Extraction error */}
      {extractErr && (
        <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{extractErr}</span>
        </div>
      )}

      {/* Zero-story diagnostic — extraction ran fine but found nothing */}
      {diagnostic && !extracting && (
        <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{diagnostic}</span>
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
