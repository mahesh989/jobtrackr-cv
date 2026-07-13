/**
 * /api/admin/view-as?mode=user|admin
 *
 * Lets a founder/admin preview the user-facing UI as themselves (their own
 * account), then return to the admin console. Sets/clears the `jt_user_view`
 * cookie; the dashboard layout + redirect read it to pick the user nav and
 * skip the admin redirect. NOT impersonation — always the admin's own data.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { ADMIN_ROLES }               from "@/lib/constants";

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/auth/login", req.url));

  const admin = createAdminClient();
  const { data: me } = await admin.from("users").select("role").eq("id", user.id).single();
  const isAdmin = !!me && (ADMIN_ROLES as readonly string[]).includes(me.role as string);
  if (!isAdmin) return NextResponse.redirect(new URL("/dashboard", req.url));

  const mode = new URL(req.url).searchParams.get("mode");
  if (mode === "user") {
    const res = NextResponse.redirect(new URL("/dashboard", req.url));
    res.cookies.set("jt_user_view", "1", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 8 });
    return res;
  }
  // Exit user-view → back to admin.
  const res = NextResponse.redirect(new URL("/dashboard/admin", req.url));
  res.cookies.delete("jt_user_view");
  return res;
}
