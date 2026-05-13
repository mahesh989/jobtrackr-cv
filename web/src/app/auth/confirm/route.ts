import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

// Supabase redirects here after the user clicks the magic link.
// Exchanges the code for a session, then marks the invite code used.
// Note: Database generic omitted until `supabase gen types` is run against the live project.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = ReturnType<typeof createServerClient<any>>;

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const inviteCode = searchParams.get("invite");

  if (!code) {
    return NextResponse.redirect(`${origin}/auth/login?error=missing_code`);
  }

  const cookieStore = await cookies();
  const supabase: AnyClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) =>
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          ),
      },
    }
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/auth/login?error=exchange_failed`);
  }

  // If this is a signup (invite code present), mark code used
  if (inviteCode) {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase
        .from("invite_codes")
        .update({ used_by: user.id, used_at: new Date().toISOString(), is_active: false })
        .eq("code", inviteCode)
        .eq("is_active", true);

      await supabase
        .from("users")
        .update({ invite_code_used: inviteCode })
        .eq("id", user.id);
    }
  }

  return NextResponse.redirect(`${origin}/dashboard`);
}
