import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { ThemePickerClient } from "@/components/ThemePickerClient";

export const metadata = { title: "Theme — JobTrackr" };

export default async function ThemeSettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  return (
    <div className="min-h-full px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-[16px] font-semibold text-text">Theme</h1>
          <p className="text-[12px] text-text-3 mt-0.5">
            Pick how JobTrackr looks. Your choice is saved to this browser —
            click any card to apply it instantly.
          </p>
        </div>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-text-3">
          Appearance
        </p>
        <ThemePickerClient />
      </div>
    </div>
  );
}
