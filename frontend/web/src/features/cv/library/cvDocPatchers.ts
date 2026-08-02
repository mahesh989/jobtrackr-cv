"use client";

/**
 * Structured-CV state updaters — extracted from ReviewClient.
 *
 * Every function here is a pure `setDoc` closure: it derives the next document
 * from the previous one and touches nothing else. Grouping them out of the
 * component leaves ReviewClient with editing/render concerns only.
 *
 * DELIBERATELY NOT MEMOISED. In the pre-extraction component these closures
 * were recreated on every render, and they are passed as props to the field
 * components. Wrapping them in useMemo/useCallback would give them stable
 * identities and therefore change when children re-render — a real behavioural
 * difference dressed up as an optimisation. This factory is called on every
 * render so identity semantics stay exactly as they were.
 */

import type { Dispatch, SetStateAction } from "react";
import type {
  StructuredCv,
  StructuredCvAward,
  StructuredCvLanguage,
  StructuredCvExperience,
  StructuredCvEducation,
  StructuredCvCertification,
  StructuredCvReferee,
  StructuredCvProject } from "@/lib/cv/backend";
import { emptyExperience, emptyEducation } from "./reviewValidation";

export function makeDocPatchers(setDoc: Dispatch<SetStateAction<StructuredCv>>) {
  const patchExperience = (i: number, next: Partial<StructuredCvExperience>) =>
    setDoc(d => ({ ...d, experience: d.experience.map((e, idx) => idx === i ? { ...e, ...next } : e) }));
  const patchEducation = (i: number, next: Partial<StructuredCvEducation>) =>
    setDoc(d => ({ ...d, education: d.education.map((e, idx) => idx === i ? { ...e, ...next } : e) }));
  const patchAward = (i: number, next: Partial<StructuredCvAward>) =>
    setDoc(d => ({ ...d, awards: (d.awards ?? []).map((a, idx) => idx === i ? { ...a, ...next } : a) }));
  const addAward = () =>
    setDoc(d => ({ ...d, awards: [...(d.awards ?? []), { name: "", issuer: "", location: "", date: "", description: "" }] }));
  const removeAward = (i: number) =>
    setDoc(d => ({ ...d, awards: (d.awards ?? []).filter((_, idx) => idx !== i) }));
  const patchLanguage = (i: number, next: Partial<StructuredCvLanguage>) =>
    setDoc(d => ({ ...d, languages: (d.languages ?? []).map((l, idx) => idx === i ? { ...l, ...next } : l) }));
  const addLanguage = () =>
    setDoc(d => ({ ...d, languages: [...(d.languages ?? []), { language: "", proficiency: "" }] }));
  const removeLanguage = (i: number) =>
    setDoc(d => ({ ...d, languages: (d.languages ?? []).filter((_, idx) => idx !== i) }));
  const patchCert = (i: number, next: Partial<StructuredCvCertification>) =>
    setDoc(d => ({ ...d, certifications: d.certifications.map((c, idx) => idx === i ? { ...c, ...next } : c) }));
  const patchReferee = (i: number, next: Partial<StructuredCvReferee>) =>
    setDoc(d => ({ ...d, references: d.references.map((r, idx) => idx === i ? { ...r, ...next } : r) }));

  const setBullet = (roleIdx: number, bulletIdx: number, value: string) =>
    setDoc(d => ({ ...d, experience: d.experience.map((e, i) =>
      i !== roleIdx ? e : { ...e, bullets: e.bullets.map((b, bi) => bi === bulletIdx ? value : b) }) }));
  const addBullet = (roleIdx: number) =>
    setDoc(d => ({ ...d, experience: d.experience.map((e, i) =>
      i !== roleIdx ? e : { ...e, bullets: [...e.bullets, ""] }) }));
  const removeBullet = (roleIdx: number, bulletIdx: number) =>
    setDoc(d => ({ ...d, experience: d.experience.map((e, i) =>
      i !== roleIdx ? e : { ...e, bullets: e.bullets.filter((_, bi) => bi !== bulletIdx) }) }));

  const addSkill = (bucket: "domain_knowledge" | "soft_skills" | "technical", value: string) => {
    const v = value.trim().toLowerCase();
    if (!v) return;
    setDoc(d => ({ ...d, skills: { ...d.skills, [bucket]: Array.from(new Set([...d.skills[bucket], v])) } }));
  };
  const removeSkill = (bucket: "domain_knowledge" | "soft_skills" | "technical", value: string) =>
    setDoc(d => ({ ...d, skills: { ...d.skills, [bucket]: d.skills[bucket].filter(s => s !== value) } }));

  const addExperience    = () => setDoc(d => ({ ...d, experience:     [...d.experience, emptyExperience()] }));
  const removeExperience = (i: number) => setDoc(d => ({ ...d, experience: d.experience.filter((_, idx) => idx !== i) }));
  const addEducation     = () => setDoc(d => ({ ...d, education:      [...d.education, emptyEducation()] }));
  const removeEducation  = (i: number) => setDoc(d => ({ ...d, education: d.education.filter((_, idx) => idx !== i) }));
  const addCertification = () => setDoc(d => ({ ...d, certifications: [...d.certifications, { name: "", issuer: "", code: "", issued_date: "" }] }));
  const removeCertification = (i: number) => setDoc(d => ({ ...d, certifications: d.certifications.filter((_, idx) => idx !== i) }));
  const addReferee = () => setDoc(d => ({ ...d, references: [...d.references, { name: "", job_title: "", company: "", email: "" }] }));
  const removeReferee = (i: number) => setDoc(d => ({ ...d, references: (d.references ?? []).filter((_, idx) => idx !== i) }));
  const patchProject = (i: number, next: Partial<StructuredCvProject>) =>
    setDoc(d => ({ ...d, projects: (d.projects ?? []).map((p, idx) => idx === i ? { ...p, ...next } : p) }));
  const addProject = () =>
    setDoc(d => ({ ...d, projects: [...(d.projects ?? []), { name: "", url: "", description: "" }] }));
  const removeProject = (i: number) =>
    setDoc(d => ({ ...d, projects: (d.projects ?? []).filter((_, idx) => idx !== i) }));

  return {
    patchExperience, patchEducation, patchAward, addAward, removeAward,
    patchLanguage, addLanguage, removeLanguage, patchCert, patchReferee,
    setBullet, addBullet, removeBullet, addSkill, removeSkill,
    addExperience, removeExperience, addEducation, removeEducation,
    addCertification, removeCertification, addReferee, removeReferee,
    patchProject, addProject, removeProject,
  };
}
