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
  const tokenHash = searchParams.get("token_hash");
  const otpType = searchParams.get("type"); // 'invite' | 'magiclink' | 'signup' | 'recovery' | 'email'
  const inviteCode = searchParams.get("invite");

  if (!code && !tokenHash) {
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

  // Establish the session from whichever link format Supabase produced:
  //  - PKCE / OTP magic links carry `code`     → exchangeCodeForSession
  //  - invite / email links carry `token_hash` → verifyOtp
  const { error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : await supabase.auth.verifyOtp({
        token_hash: tokenHash!,
        type: (otpType as "invite" | "magiclink" | "signup" | "recovery" | "email") ?? "email",
      });
  if (error) {
    return NextResponse.redirect(`${origin}/auth/login?error=exchange_failed`);
  }

  // If this is a signup (invite code present), stamp who used the code.
  // The code was already consumed (is_active=false) when /api/auth/signup
  // claimed it, so match on used_by IS NULL to record the user id now.
  if (inviteCode) {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase
        .from("invite_codes")
        .update({ used_by: user.id, used_at: new Date().toISOString(), is_active: false })
        .eq("code", inviteCode)
        .is("used_by", null);

      await supabase
        .from("users")
        .update({ invite_code_used: inviteCode })
        .eq("id", user.id);
    }
  }

  return NextResponse.redirect(`${origin}/dashboard`);
}
