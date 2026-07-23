/**
 * proxy.ts — Next's middleware (renamed `proxy` in this Next version).
 *
 * ⚠️ DO NOT DELETE AS "DEAD CODE". Nothing in-repo imports `proxy`/`config` —
 * the FRAMEWORK invokes them by file convention, exactly like page.tsx. This
 * file was once removed by an automated cleanup and every logged-in session
 * started dying after ~1 hour with "Invalid Refresh Token: Refresh Token Not
 * Found": this is the ONLY place the Supabase session can be refreshed AND
 * the rotated cookies written back to the browser. Server Components cannot
 * persist cookies (lib/supabase/server.ts setAll is a deliberate no-op), so
 * without this file a refresh consumes the token, the new one is lost, and
 * the browser's next request presents an already-used refresh token → crash.
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { User } from "@supabase/supabase-js";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public marketing routes never gate on auth here and never redirect based on
  // `user`, so skip the Supabase auth.getUser() network round-trip entirely for
  // them. Pages that genuinely need the session (e.g. the landing page's
  // logged-in → / redirect) resolve it server-side themselves, and a
  // logged-in user's token still refreshes on their next protected navigation.
  // This shaves a round-trip off every anonymous landing/pricing/privacy hit.
  const isPublicRoute =
    pathname === "/" ||
    pathname === "/pricing" ||
    pathname === "/privacy" ||
    pathname === "/terms";
  if (isPublicRoute) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh session — must happen before any auth checks. A poisoned session
  // (e.g. a refresh token already consumed while this file was missing, or a
  // user deleted server-side) must degrade to signed-out + cleared cookies,
  // not throw — otherwise every page render crashes until the user manually
  // clears cookies.
  let user: User | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch {
    user = null;
    for (const c of request.cookies.getAll()) {
      if (c.name.startsWith("sb-")) supabaseResponse.cookies.delete(c.name);
    }
  }

  const isAuthRoute = pathname.startsWith("/auth");
  const isApiRoute = pathname.startsWith("/api");

  // Redirect unauthenticated users to login (public routes already returned
  // above; auth + api routes are exempt here).
  if (!user && !isAuthRoute && !isApiRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/auth/login";
    const redirect = NextResponse.redirect(url);
    // Carry any cookie deletions from the poisoned-session path onto the
    // redirect response so the browser actually drops the stale token.
    for (const c of request.cookies.getAll()) {
      if (c.name.startsWith("sb-") && supabaseResponse.cookies.get(c.name)?.value === "") {
        redirect.cookies.delete(c.name);
      }
    }
    return redirect;
  }

  // Redirect authenticated users away from auth pages.
  // /auth/signout must be excluded — it's the POST handler that actually clears the session.
  // /auth/update-password must be excluded — reached via an authenticated
  // password-recovery session (the user must stay signed in to set the new
  // password there).
  const AUTH_ROUTE_EXEMPT = new Set(["/auth/callback", "/auth/confirm", "/auth/signout", "/auth/update-password"]);
  if (user && isAuthRoute && !AUTH_ROUTE_EXEMPT.has(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  // Server Components can't read the current pathname directly — stamp it on
  // a response header so the dashboard layout can gate on it (e.g. skip the
  // first-run setup redirect while already on the setup page itself).
  supabaseResponse.headers.set("x-pathname", pathname);

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
