"use client";

import { useState } from "react";
import { CurrentProfileCard } from "./CurrentProfileCard";
import { SuccessResultCard } from "./SuccessResultCard";
import { CaptureForm } from "./CaptureForm";
import { WORD_MIN, countWords, type SourceTag, type SubmitResult, type VoiceProfile } from "./types";

interface Props {
  initialProfile: VoiceProfile | null;
}

export function CaptureClient({ initialProfile }: Props) {
  const [activeTab,  setActiveTab]  = useState<SourceTag>("in_app_capture");
  const [writtenText, setWrittenText] = useState("");
  const [pastedText,  setPastedText]  = useState("");

  const [status,      setStatus]      = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [result,      setResult]      = useState<SubmitResult | null>(null);
  const [errorMsg,    setErrorMsg]    = useState<string | null>(null);
  const [showForm,    setShowForm]    = useState<boolean>(!initialProfile);

  const text = activeTab === "in_app_capture" ? writtenText : pastedText;
  const setText = activeTab === "in_app_capture" ? setWrittenText : setPastedText;
  const words     = countWords(text);
  const canSubmit = words >= WORD_MIN && status !== "submitting";

  function startEditing(prefill?: string) {
    const source = (initialProfile?.voice_sample_source ?? "in_app_capture") as SourceTag;
    setActiveTab(source);
    if (source === "in_app_capture") setWrittenText(prefill ?? initialProfile?.voice_sample_raw ?? "");
    else                              setPastedText(prefill  ?? initialProfile?.voice_sample_raw ?? "");
    setErrorMsg(null);
    setShowForm(true);
  }

  function handleReplace() {
    setActiveTab("in_app_capture");
    setWrittenText("");
    setPastedText("");
    setShowForm(true);
    setErrorMsg(null);
  }

  function handleCancel() {
    setShowForm(false);
    setWrittenText("");
    setPastedText("");
    setErrorMsg(null);
  }

  function handleReset() {
    setStatus("idle");
    setResult(null);
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setStatus("submitting");
    setErrorMsg(null);

    try {
      const res  = await fetch("/api/user/voice-profile", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          voice_sample_text: text,
          source:            activeTab,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg((data as { error?: string }).error ?? "Something went wrong. Please try again.");
        setStatus("error");
        return;
      }
      setResult(data as SubmitResult);
      setStatus("success");
      setWrittenText("");
      setPastedText("");
    } catch {
      setErrorMsg("Network error. Please try again.");
      setStatus("error");
    }
  }

  return (
    <div className="space-y-6">
      {initialProfile && status !== "success" && !showForm && (
        <CurrentProfileCard
          profile={initialProfile}
          onEdit={startEditing}
          onReplace={handleReplace}
        />
      )}

      {status === "success" && result && (
        <SuccessResultCard result={result} onReset={handleReset} />
      )}

      {status !== "success" && showForm && (
        <CaptureForm
          activeTab={activeTab}
          onTabChange={setActiveTab}
          text={text}
          onTextChange={setText}
          words={words}
          status={status}
          errorMsg={errorMsg}
          canSubmit={canSubmit}
          isEditing={!!initialProfile}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          showCancel={!!initialProfile && status !== "submitting"}
        />
      )}
    </div>
  );
}
