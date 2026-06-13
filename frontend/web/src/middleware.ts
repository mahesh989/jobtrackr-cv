import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public marketing routes never gate on auth here and never redirect based on
  // `user`, so skip the Supabase auth.getUser() network round-trip entirely for
  // them. Pages that genuinely need the session (e.g. the landing page's
  // logged-in → /dashboard redirect) resolve it server-side themselves, and a
  // logged-in user's token still refreshes on their next protected navigation.
  // This shaves a round-trip off every anonymous landing/pricing/privacy hit.
  const isPublicRoute =
    pathname === "/" || pathname === "/privacy" || pathname === "/terms";
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
  if (user && isAuthRoute && pathname !== "/auth/callback" && pathname !== "/auth/confirm" && pathname !== "/auth/signout") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
