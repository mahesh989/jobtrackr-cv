"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { ADMIN_ROLES } from "@/lib/constants";
import { authedClient } from "./_helpers";

async function requireAdminRole() {
  const { supabase, user } = await authedClient();
  const { data } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (!data || !(ADMIN_ROLES as readonly string[]).includes(data.role)) {
    throw new Error("Forbidden");
  }
  return user;
}

export async function generateInviteCode() {
  const user = await requireAdminRole();
  const adminClient = createAdminClient();
  const code = "JT" + crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const { error } = await adminClient.from("invite_codes").insert({ code, created_by: user.id });
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/admin");
}

export async function revokeInviteCode(code: string) {
  await requireAdminRole();
  const adminClient = createAdminClient();
  await adminClient
    .from("invite_codes")
    .update({ is_active: false })
    .eq("code", code)
    .is("used_by", null); // only revoke unused codes
  revalidatePath("/dashboard/admin");
}

