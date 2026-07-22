import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

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

  // Refresh session — must happen before any auth checks
  const { data: { user } } = await supabase.auth.getUser();

  const isAuthRoute = pathname.startsWith("/auth");
  const isApiRoute = pathname.startsWith("/api");

  // Redirect unauthenticated users to login (public routes already returned
  // above; auth + api routes are exempt here).
  if (!user && !isAuthRoute && !isApiRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/auth/login";
    return NextResponse.redirect(url);
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
