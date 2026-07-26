import { NextRequest, NextResponse } from "next/server";
import { createClient }               from "@/lib/supabase/server";
import { createAdminClient }          from "@/lib/supabase/admin";
import { ADMIN_ROLES }                from "@/lib/constants";

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export function jsonOk(data: unknown) {
  return NextResponse.json(data);
}

export async function requireUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { user: null, error: jsonError("Unauthorized", 401) as NextResponse };
  return { user, error: null };
}

export async function requireAdmin(user: { id: string }, supabaseClient?: Awaited<ReturnType<typeof createClient>>) {
  const client = supabaseClient ?? createAdminClient();
  const { data: me } = await client.from("users").select("role").eq("id", user.id).single();
  if (!me || !(ADMIN_ROLES as readonly string[]).includes(me.role as string)) {
    return { userId: user.id, admin: client, error: jsonError("Forbidden", 403) as NextResponse };
  }
  return { userId: user.id, admin: client, error: null };
}

export async function parseJsonBody<T>(req: NextRequest): Promise<{ data: T; error: null } | { data: null; error: NextResponse }> {
  try {
    const data = (await req.json()) as T;
    return { data, error: null };
  } catch {
    return { data: null, error: jsonError("Invalid JSON body", 400) };
  }
}

// ── Structural auth wrappers ─────────────────────────────────────────────────
// Route handlers wrapped in withUser()/withAdmin() are incapable of skipping
// auth: the wrapper acquires the session, denies with 401/403 itself, and only
// then invokes the handler — with a guaranteed non-null `user` and the same
// RLS-scoped `supabase` client it used (no second client construction).
// scripts/check-route-auth.mjs treats these as the canonical guard pattern.
//
// Identity comes from getClaims(), which VERIFIES THE JWT SIGNATURE LOCALLY
// against the project's public JWKS (cached in-process) — this project signs
// with ES256, an asymmetric key, so no Auth-server round trip is needed. It is
// exactly as trustworthy as getUser() for establishing identity (Supabase's own
// docs name getClaims() as the secure choice alongside getUser(), in contrast
// to the unverified getSession()), and it is what every request here used to
// spend ~250ms on.
//
// That cost was paid TWICE per API call: proxy.ts already validates the session
// on the way in, and then each route validated it again. Across 50+ routes that
// was the single largest fixed cost on the app, on every click.
//
// Only `id` and `email` are exposed, because that is all any route uses (127
// and 4 references respectively at time of writing). If a handler ever needs
// the full User record it should fetch it explicitly rather than making every
// other route pay for a network round trip it does not use.

type RouteCtx = { params: Promise<Record<string, string>> };

/** The subset of `User` that routes actually consume, sourced from verified
 *  JWT claims. Structurally assignable to the old `User`-typed field for the
 *  properties in use, so handlers need no changes. */
export interface AuthedUser {
  id:    string;
  email: string | undefined;
}

export interface AuthedRoute {
  user:     AuthedUser;
  supabase: Awaited<ReturnType<typeof createClient>>;
}

/** Verify the caller's JWT locally and return the identity it asserts.
 *  Null when there is no session or the signature/expiry does not check out. */
async function claimsUser(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<AuthedUser | null> {
  const { data, error } = await supabase.auth.getClaims();
  const sub = data?.claims?.sub;
  if (error || !sub) return null;
  const email = data.claims.email;
  return { id: sub, email: typeof email === "string" ? email : undefined };
}

export interface AdminRoute extends AuthedRoute {
  userId: string;
  admin:  ReturnType<typeof createAdminClient>;
}

/** Wrap a route handler so it only runs for an authenticated user (else 401). */
export function withUser<C extends RouteCtx = RouteCtx>(
  handler: (req: NextRequest, ctx: C, auth: AuthedRoute) => Promise<Response> | Response,
) {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    const supabase = await createClient();
    const user = await claimsUser(supabase);
    if (!user) return jsonError("Unauthorized", 401);
    return handler(req, ctx, { user, supabase });
  };
}

/** Wrap a route handler so it only runs for founder/admin users (else 401/403). */
export function withAdmin<C extends RouteCtx = RouteCtx>(
  handler: (req: NextRequest, ctx: C, auth: AdminRoute) => Promise<Response> | Response,
) {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    const supabase = await createClient();
    const user = await claimsUser(supabase);
    if (!user) return jsonError("Unauthorized", 401);
    const { userId, admin, error } = await requireAdmin(user);
    if (error) return error;
    return handler(req, ctx, { user, supabase, userId, admin });
  };
}
