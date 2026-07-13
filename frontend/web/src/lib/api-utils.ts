import { NextRequest, NextResponse } from "next/server";
import type { User }                  from "@supabase/supabase-js";
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

export async function requireAdmin(user: User, supabaseClient?: Awaited<ReturnType<typeof createClient>>) {
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
