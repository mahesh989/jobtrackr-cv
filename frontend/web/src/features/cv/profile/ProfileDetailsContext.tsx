"use client";

import {
  createContext, useContext, useReducer, useMemo, useEffect, useRef, type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import type { ContactDetails, ProfileCredentials, RoleFamily } from "@/lib/types";
import type { Referee, ReferencesMode, ReferencesData } from "./referencesTypes";

export type { Referee, ReferencesMode, ReferencesData };

/** Lifecycle of the background autosave — drives the AutoSaveBadge. */
export type AutoSaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

export const MAX_REFEREES = 3;
export const CONTACT_KEYS = [
  "name", "phone", "email", "address", "suburb", "postcode",
  "linkedin", "github", "website", "portfolio", "other_label", "other_url",
] as const;

const REQUIRED_CONTACT_KEYS = ["name", "phone", "email", "suburb", "address", "postcode"] as const;

function resolveInitialMode(data: ReferencesData | null | undefined): ReferencesMode {
  if (!data) return "none";
  if (data.mode) return data.mode;
  return data.available_on_request ? "on_request" : "details";
}

// ── Reducer ──────────────────────────────────────────────────────────────────
// One state object instead of 12 parallel useStates. Every edit action bakes
// in the old `touch()` coupling (dirty=true, saved=false, autoStatus=pending)
// so it can never be forgotten on a new field type.

interface State {
  cd:         ContactDetails;
  family:     RoleFamily | null;
  creds:      ProfileCredentials;
  refMode:    ReferencesMode;
  referees:   Referee[];
  dirty:      boolean;
  saving:     boolean;
  saved:      boolean;
  error:      string | null;
  showErrors: boolean;
  autoStatus: AutoSaveStatus;
}

type Action =
  | { type: "field"; key: (typeof CONTACT_KEYS)[number]; value: string }
  | { type: "family"; family: RoleFamily | null }
  | { type: "cred"; key: keyof ProfileCredentials; value: ProfileCredentials[keyof ProfileCredentials] }
  | { type: "refMode"; mode: ReferencesMode }
  | { type: "addReferee" }
  | { type: "removeReferee"; index: number }
  | { type: "patchReferee"; index: number; field: keyof Referee; value: string }
  | { type: "setReferees"; referees: Referee[] }
  | { type: "autoSaveStart" }
  | { type: "autoSaveResult"; ok: boolean }
  | { type: "saveValidationFailed"; message: string }
  | { type: "saveStart" }
  | { type: "saveSuccess"; cleanedReferees: Referee[] }
  | { type: "saveError"; message: string }
  | { type: "saveSettled" }
  | { type: "clearSavedFlash" };

/** dirty + badge coupling applied by every edit action (the old touch()). */
function touched(s: State): State {
  return { ...s, dirty: true, saved: false, autoStatus: "pending" };
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "field":         return touched({ ...s, cd: { ...s.cd, [a.key]: a.value } });
    case "family":        return touched({ ...s, family: a.family });
    case "cred":          return touched({ ...s, creds: { ...s.creds, [a.key]: a.value } });
    case "refMode":       return touched({ ...s, refMode: a.mode });
    case "addReferee":
      return s.referees.length >= MAX_REFEREES
        ? touched(s)
        : touched({ ...s, referees: [...s.referees, { name: "", job_title: "", company: "", email: "" }] });
    case "removeReferee": return touched({ ...s, referees: s.referees.filter((_, i) => i !== a.index) });
    case "patchReferee":
      return touched({
        ...s,
        referees: s.referees.map((r, i) => (i === a.index ? { ...r, [a.field]: a.value } : r)),
      });
    case "setReferees":   return touched({ ...s, referees: a.referees });

    case "autoSaveStart":  return { ...s, autoStatus: "saving" };
    case "autoSaveResult": return a.ok
      ? { ...s, dirty: false, autoStatus: "saved" }
      : { ...s, autoStatus: "error" }; // badge surfaces it; next edit retries

    case "saveValidationFailed":
      return { ...s, showErrors: true, error: a.message };
    case "saveStart":
      return { ...s, showErrors: false, saving: true, error: null, saved: false };
    case "saveSuccess":
      return { ...s, referees: a.cleanedReferees, dirty: false, autoStatus: "saved", saved: true };
    case "saveError":      return { ...s, error: a.message };
    case "saveSettled":    return { ...s, saving: false };
    case "clearSavedFlash": return { ...s, saved: false };
  }
}

// ── Context ──────────────────────────────────────────────────────────────────

export interface Ctx {
  cd:        ContactDetails;
  setField:  <K extends typeof CONTACT_KEYS[number]>(k: K, v: string) => void;
  family:    RoleFamily | null;
  setFamily: (f: RoleFamily | null) => void;
  creds:     ProfileCredentials;
  setCred:   <K extends keyof ProfileCredentials>(k: K, v: ProfileCredentials[K]) => void;
  refMode:   ReferencesMode;
  setRefMode: (m: ReferencesMode) => void;
  referees:  Referee[];
  addReferee: () => void;
  removeReferee: (i: number) => void;
  patchReferee: (i: number, field: keyof Referee, value: string) => void;
  setReferees: (r: Referee[]) => void;
  activeCvId: string | null;
  dirty:     boolean;
  saving:    boolean;
  saved:     boolean;
  error:     string | null;
  showErrors: boolean;
  autoStatus: AutoSaveStatus;
  save:      () => Promise<void>;
}

const ProfileCtx = createContext<Ctx | null>(null);

export function useProfile(): Ctx {
  const c = useContext(ProfileCtx);
  if (!c) throw new Error("Profile sections must render inside <ProfileDetailsProvider>");
  return c;
}

export function ProfileDetailsProvider({
  initial, activeCvId, children, requireVertical = false,
}: {
  initial:    ContactDetails | null;
  activeCvId: string | null;
  children:   ReactNode;
  /** Explicit Save validates role-type selection ONLY where the selector is
   *  actually rendered (VerticalsSection on /cv). The details page has no
   *  selector — blocking its Save on a field the user cannot see was the
   *  "select a role type before saving" dead-end. */
  requireVertical?: boolean;
}) {
  const router = useRouter();
  const init = initial ?? {};

  const initialContact = useMemo(() => {
    const out: ContactDetails = {};
    for (const k of CONTACT_KEYS) {
      const v = (init as Record<string, unknown>)[k];
      if (typeof v === "string") (out as Record<string, string>)[k] = v;
    }
    return out;
  }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps

  const initRefs = (init as { references?: ReferencesData }).references;
  const initFamilies = init.role_families ?? [];

  const [state, dispatch] = useReducer(reducer, undefined, (): State => ({
    cd:         initialContact,
    family:     initFamilies.length > 0 ? initFamilies[0] : null,
    creds:      init.credentials ?? {},
    refMode:    resolveInitialMode(initRefs),
    referees:   initRefs?.referees ?? [],
    dirty:      false,
    saving:     false,
    saved:      false,
    error:      null,
    showErrors: false,
    autoStatus: "idle",
  }));

  const { cd, family, creds, refMode, referees, dirty } = state;

  const buildPayload = () => ({
    ...cd,
    role_families: family ? [family] : [],
    credentials:   creds,
    references:    {
      mode: refMode,
      referees: referees
        .filter((r) => r.name?.trim() || r.job_title?.trim() || r.company?.trim() || r.email?.trim())
        .slice(0, MAX_REFEREES),
    },
  });

  // Autosave — the CV upload flow navigates away to the review form
  // (router.push), unmounting this provider and discarding unsaved state.
  // Persist edits automatically after a quiet period so nothing typed is
  // ever lost to navigation. No validation gate here (the PATCH endpoint
  // accepts partial contact_details); the Save button keeps the
  // required-field check for explicit "profile complete" confirmation.
  const payloadRef = useRef(buildPayload);
  useEffect(() => {
    payloadRef.current = buildPayload;
  });
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      dispatch({ type: "autoSaveStart" });
      void fetch("/api/user/preferences", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ contact_details: payloadRef.current() }),
      }).then((res) => {
        dispatch({ type: "autoSaveResult", ok: res.ok });
      })
        .catch(() => dispatch({ type: "autoSaveResult", ok: false }));
    }, 1200);
    return () => clearTimeout(t);
  }, [dirty, cd, family, creds, refMode, referees]);

  const ctx: Ctx = {
    cd,
    setField: (k, v) => dispatch({ type: "field", key: k, value: v }),
    family,
    setFamily: (f) => dispatch({ type: "family", family: f }),
    creds,
    setCred: (k, v) => dispatch({ type: "cred", key: k, value: v }),
    refMode,
    setRefMode: (m) => dispatch({ type: "refMode", mode: m }),
    referees,
    addReferee: () => dispatch({ type: "addReferee" }),
    removeReferee: (i) => dispatch({ type: "removeReferee", index: i }),
    patchReferee: (i, field, value) => dispatch({ type: "patchReferee", index: i, field, value }),
    setReferees: (r) => dispatch({ type: "setReferees", referees: r }),
    activeCvId,
    dirty,
    saving:     state.saving,
    saved:      state.saved,
    error:      state.error,
    showErrors: state.showErrors,
    autoStatus: state.autoStatus,
    save: async () => {
      const missingContact = REQUIRED_CONTACT_KEYS.filter(
        (k) => !((cd as Record<string, string>)[k] ?? "").trim()
      );
      const noVertical = requireVertical && family === null;
      if (missingContact.length > 0 || noVertical) {
        dispatch({
          type: "saveValidationFailed",
          message:
            noVertical && missingContact.length > 0
              ? "Fill the required contact fields and pick a role type."
              : noVertical
                ? "Select a role type before saving."
                : "Fill the required contact fields highlighted in red.",
        });
        if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      dispatch({ type: "saveStart" });
      const cleanedRefs = referees.filter((r) => r.name?.trim() || r.job_title?.trim() || r.company?.trim() || r.email?.trim());
      const payload = buildPayload();
      try {
        const res = await fetch("/api/user/preferences", {
          method:  "PATCH",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ contact_details: payload }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) { dispatch({ type: "saveError", message: json.error ?? `Save failed (${res.status})` }); return; }
        dispatch({ type: "saveSuccess", cleanedReferees: cleanedRefs });
        setTimeout(() => dispatch({ type: "clearSavedFlash" }), 2500);
        router.refresh();
      } catch (e) {
        dispatch({ type: "saveError", message: e instanceof Error ? e.message : "Network error" });
      } finally {
        dispatch({ type: "saveSettled" });
      }
    },
  };

  return <ProfileCtx.Provider value={ctx}>{children}</ProfileCtx.Provider>;
}
