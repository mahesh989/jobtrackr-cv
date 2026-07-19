import { NextRequest } from "next/server";
import { handleAuthConfirm } from "@/features/auth/server";

// Supabase redirects here after the user clicks the magic link.
export async function GET(request: NextRequest) {
  return handleAuthConfirm(request);
}
