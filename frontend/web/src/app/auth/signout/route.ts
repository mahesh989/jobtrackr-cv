import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

// Sign the user out via Supabase and redirect to the login page.
// The sidebar uses <form action="/auth/signout" method="post"> so this
// route only needs to handle POST. We also handle GET as a safety net
// in case someone hits the URL directly.
async function signOut(request: NextRequest) {
  const { origin } = new URL(request.url);
  const cookieStore = await cookies();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createServerClient<any>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) =>
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          ),
      },
    },
  );

  await supabase.auth.signOut();

  return NextResponse.redirect(`${origin}/auth/login`, {
    // 303 forces the browser to use GET on the redirect target,
    // which is the correct pattern after a POST form submission.
    status: 303,
  });
}

export async function POST(request: NextRequest) {
  return signOut(request);
}

export async function GET(request: NextRequest) {
  return signOut(request);
}
