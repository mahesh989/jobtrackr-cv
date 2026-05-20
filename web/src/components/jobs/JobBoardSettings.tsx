"use client";

/**
 * Gear-icon dropdown — display preferences for the job board.
 * Local-only, persisted to localStorage. No DB.
 *
 * Toggles broadcast via a CustomEvent("job-board-settings-changed") so
 * any component that uses useJobBoardSettings() re-renders without
 * prop-drilling.
 */

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";

export interface JobBoardSettings {
  showRailOnAllTabs:       boolean;
  hideProgressOnDismissed: boolean;
  hideRail:                boolean;
  showProgressColumnLabel: boolean;
}

const STORAGE_KEY = "jobtrackr-jobs-settings";

export const DEFAULT_JOB_BOARD_SETTINGS: JobBoardSettings = {
  showRailOnAllTabs:       false,
  hideProgressOnDismissed: false,
  hideRail:                false,
  showProgressColumnLabel: true,
};

export function readJobBoardSettings(): JobBoardSettings {
  if (typeof window === "undefined") return DEFAULT_JOB_BOARD_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_JOB_BOARD_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<JobBoardSettings>;
    return { ...DEFAULT_JOB_BOARD_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_JOB_BOARD_SETTINGS;
  }
}

function writeSettings(s: JobBoardSettings) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    window.dispatchEvent(new CustomEvent("job-board-settings-changed"));
  } catch { /* quota */ }
}

/** Hook — any client component reacts to settings changes live. */
export function useJobBoardSettings(): JobBoardSettings {
  const [s, setS] = useState<JobBoardSettings>(DEFAULT_JOB_BOARD_SETTINGS);
  useEffect(() => {
    setS(readJobBoardSettings());
    const handler = () => setS(readJobBoardSettings());
    window.addEventListener("job-board-settings-changed", handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener("job-board-settings-changed", handler);
      window.removeEventListener("storage", handler);
    };
  }, []);
  return s;
}

export function JobBoardSettingsPanel() {
  const [open, setOpen]   = useState(false);
  const [s, setS]         = useState<JobBoardSettings>(DEFAULT_JOB_BOARD_SETTINGS);
  const [pos, setPos]     = useState<{ top: number; right: number } | null>(null);
  const btnRef            = useRef<HTMLButtonElement>(null);
  const menuRef           = useRef<HTMLDivElement>(null);

  useEffect(() => { setS(readJobBoardSettings()); }, []);

  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        btnRef.current  && !btnRef.current .contains(e.target as Node)
      ) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setOpen((v) => !v);
  }

  function update<K extends keyof JobBoardSettings>(k: K, v: JobBoardSettings[K]) {
    const next = { ...s, [k]: v };
    setS(next);
    writeSettings(next);
  }

  function reset() {
    setS(DEFAULT_JOB_BOARD_SETTINGS);
    writeSettings(DEFAULT_JOB_BOARD_SETTINGS);
  }

  const Row = ({ k, label, hint }: { k: keyof JobBoardSettings; label: string; hint: string }) => (
    <label className="flex items-start gap-2.5 px-3 py-2 hover:bg-[var(--surface-2)] cursor-pointer transition-colors">
      <input
        type="checkbox"
        checked={s[k]}
        onChange={(e) => update(k, e.target.checked)}
        className="mt-0.5 shrink-0"
      />
      <div className="min-w-0">
        <p className="text-[12px] font-medium text-text">{label}</p>
        <p className="text-[11px] text-text-3 leading-snug">{hint}</p>
      </div>
    </label>
  );

  const menu = open && pos ? (
    <div
      ref={menuRef}
      style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 9999, width: 320 }}
      className="rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-2 border-b border-[var(--border)] bg-[var(--surface-2)]">
        <p className="text-[12px] font-semibold text-text">Display settings</p>
        <p className="text-[11px] text-text-3 leading-snug mt-0.5">
          Stored in your browser. No data leaves this device.
        </p>
      </div>

      <Row
        k="showRailOnAllTabs"
        label="Show continue-rail on every tab"
        hint="Default: only on the Active tab."
      />
      <Row
        k="hideProgressOnDismissed"
        label="Hide progress icons on dismissed jobs"
        hint="Default: show greyed dots so you remember what was already done."
      />
      <Row
        k="hideRail"
        label="Hide the continue-rail entirely"
        hint="If it feels noisy, kill it. Toggle back on any time."
      />
      <Row
        k="showProgressColumnLabel"
        label='Show "Progress" column header'
        hint="If off, the four icons sit under a blank header."
      />

      <div className="px-3 py-2 border-t border-[var(--border)] flex items-center justify-between">
        <button
          onClick={reset}
          className="text-[11px] text-text-3 hover:text-text underline-offset-2 hover:underline"
        >
          Reset to defaults
        </button>
        <button
          onClick={() => setOpen(false)}
          className="text-[11px] font-medium text-[var(--brand)] hover:underline"
        >
          Done
        </button>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        title="Display settings"
        className={`gh-btn inline-flex items-center gap-1.5 text-[11px] px-2 py-1 ${
          open ? "border-[var(--brand)] text-[var(--brand)]" : ""
        }`}
      >
        <Settings2 className="w-3.5 h-3.5" />
        Display
      </button>
      {typeof document !== "undefined" && menu && createPortal(menu, document.body)}
    </>
  );
}
