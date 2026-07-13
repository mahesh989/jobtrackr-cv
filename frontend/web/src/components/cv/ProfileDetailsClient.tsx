"use client";

/**
 * Barrel re-export — all profile-detail sections now live in ./profile-details/.
 * This file keeps the public API identical so the dashboard page needs zero changes.
 */
export { ProfileDetailsProvider } from "./profile-details/context";
export { ContactSection } from "./profile-details/ContactSection";
export { VerticalsSection } from "./profile-details/VerticalsSection";
export { CredentialsSection } from "./profile-details/CredentialsSection";
export { AvailabilitySection } from "./profile-details/AvailabilitySection";
export { ReferencesSubSection } from "./profile-details/ReferencesSubSection";
export { ProfileSaveBar } from "./profile-details/ProfileSaveBar";
