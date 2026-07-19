import { redirect } from "next/navigation";

// AI keys have been merged into the Integrations page. This route stays as a
// redirect so any bookmarks / old sidebar caches still land somewhere useful.
export default function AiKeysRedirect() {
  redirect("/integrations");
}
