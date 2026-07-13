/**
 * Auth module — server-only surface. Import from route handlers, Server
 * Components, and API routes; never from client components.
 */

export { getAuthUser, requireUser } from "./guards";
export { validateInviteCode, type InviteValidation } from "./invites";
export { signupWithInvite, type SignupResult } from "./signup";
export { handleAuthConfirm } from "./confirm";
export { handleSignOut } from "./signout";
