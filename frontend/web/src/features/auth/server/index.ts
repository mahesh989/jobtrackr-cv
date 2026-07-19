/**
 * Auth module — server-only surface. Import from route handlers, Server
 * Components, and API routes; never from client components.
 */

export { getAuthUser, requireUser } from "./guards";
export { handleAuthConfirm } from "./confirm";
export { handleSignOut } from "./signout";
export { checkSsoOnly } from "./passwordReset";
