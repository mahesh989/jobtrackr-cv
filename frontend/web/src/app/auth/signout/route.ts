import { NextRequest } from "next/server";
import { handleSignOut } from "@/modules/auth/server";

// The sidebar uses <form action="/auth/signout" method="post">; GET is a
// safety net for direct URL hits.
export async function POST(request: NextRequest) {
  return handleSignOut(request);
}

export async function GET(request: NextRequest) {
  return handleSignOut(request);
}
