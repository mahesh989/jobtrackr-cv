/**
 * Sign the user out via Supabase and redirect to the login page.
 * The sidebar uses <form action="/auth/signout" method="post"> so the route
 * only needs POST; GET is handled too as a safety net for direct URL hits.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function handleSignOut(request: NextRequest): Promise<NextResponse> {
  const { origin } = new URL(request.url);
  const supabase = await createClient();

  await supabase.auth.signOut();

  return NextResponse.redirect(`${origin}/auth/login`, {
    // 303 forces the browser to use GET on the redirect target,
    // which is the correct pattern after a POST form submission.
    status: 303,
  });
}
