"use client";

import {
  createContext, useContext, useState, useMemo, type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import type { ContactDetails, ProfileCredentials, RoleFamily } from "@/components/cv/ProfileSettingsClient";
import type { Referee, ReferencesMode, ReferencesData } from "@/components/cv/ReferencesSection";

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
  save:      () => Promise<void>;
}

const ProfileCtx = createContext<Ctx | null>(null);

export function useProfile(): Ctx {
  const c = useContext(ProfileCtx);
  if (!c) throw new Error("Profile sections must render inside <ProfileDetailsProvider>");
  return c;
}

export function ProfileDetailsProvider({
  initial, activeCvId, children,
}: {
  initial:    ContactDetails | null;
  activeCvId: string | null;
  children:   ReactNode;
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
  const [cd, setCd]           = useState<ContactDetails>(initialContact);
  const initFamilies          = init.role_families ?? [];
  const [family, setFamilySt] = useState<RoleFamily | null>(initFamilies.length > 0 ? initFamilies[0] : null);
  const [creds, setCreds]     = useState<ProfileCredentials>(init.credentials ?? {});
  const [refMode, setRefMode]   = useState<ReferencesMode>(resolveInitialMode(initRefs));
  const [referees, setReferees] = useState<Referee[]>(initRefs?.referees ?? []);

  const [dirty, setDirty]   = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const touch = () => { setDirty(true); setSaved(false); };

  const ctx: Ctx = {
    cd,
    setField: (k, v) => { setCd((p) => ({ ...p, [k]: v })); touch(); },
    family,
    setFamily: (f) => { setFamilySt(f); touch(); },
    creds,
    setCred: (k, v) => { setCreds((p) => ({ ...p, [k]: v })); touch(); },
    refMode,
    setRefMode: (m) => { setRefMode(m); touch(); },
    referees,
    addReferee: () => { setReferees((p) => p.length >= MAX_REFEREES ? p : [...p, { name: "", job_title: "", company: "", email: "" }]); touch(); },
    removeReferee: (i) => { setReferees((p) => p.filter((_, idx) => idx !== i)); touch(); },
    patchReferee: (i, field, value) => { setReferees((p) => p.map((r, idx) => idx === i ? { ...r, [field]: value } : r)); touch(); },
    setReferees: (r) => { setReferees(r); touch(); },
    activeCvId,
    dirty, saving, saved, error, showErrors,
    save: async () => {
      const missingContact = REQUIRED_CONTACT_KEYS.filter(
        (k) => !((cd as Record<string, string>)[k] ?? "").trim()
      );
      const noVertical = family === null;
      if (missingContact.length > 0 || noVertical) {
        setShowErrors(true);
        setError(
          noVertical && missingContact.length > 0
            ? "Fill the required contact fields and pick a role type."
            : noVertical
              ? "Select a role type before saving."
              : "Fill the required contact fields highlighted in red."
        );
        if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      setShowErrors(false);
      setSaving(true); setError(null); setSaved(false);
      const cleanedRefs = referees.filter((r) => r.name?.trim() || r.job_title?.trim() || r.company?.trim() || r.email?.trim());
      const payload = {
        ...cd,
        role_families: family ? [family] : [],
        credentials:   creds,
        references:    { mode: refMode, referees: cleanedRefs.slice(0, MAX_REFEREES) },
      };
      try {
        const res = await fetch("/api/user/preferences", {
          method:  "PATCH",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ contact_details: payload }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) { setError(json.error ?? `Save failed (${res.status})`); return; }
        setReferees(cleanedRefs);
        setDirty(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Network error");
      } finally {
        setSaving(false);
      }
    },
  };

  return <ProfileCtx.Provider value={ctx}>{children}</ProfileCtx.Provider>;
}
