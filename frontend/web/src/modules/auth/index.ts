/**
 * Auth module — public client-safe surface (screens + widgets).
 *
 * Server-side helpers (guards, signup, confirm, signout, invites) are
 * deliberately NOT re-exported here: they import server-only APIs
 * (next/headers) and must be imported from "@/modules/auth/server" instead,
 * so a client component can never pull them in via this barrel.
 */

export { LoginForm } from "./components/LoginForm";
export { SignupForm } from "./components/SignupForm";
export { TurnstileBox, type TurnstileBoxHandle } from "./components/TurnstileBox";
