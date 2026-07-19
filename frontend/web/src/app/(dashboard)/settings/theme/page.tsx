import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { ThemePickerClient } from "@/components/navigation/ThemePickerClient";
import { DensityPickerClient } from "@/components/navigation/DensityPickerClient";

export const metadata = { title: "Theme — JobTrackr" };

export default async function ThemeSettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  return (
    <div className="min-h-full px-4 sm:px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="page-title text-text">Theme</h1>
          <p className="page-subtitle">
            Pick how JobTrackr looks. Your choice is saved to this browser —
            click any card to apply it instantly.
          </p>
        </div>
        <p className="label-luxury text-text-3">Appearance</p>
        <ThemePickerClient />

        <div className="pt-2">
          <p className="label-luxury text-text-3">Text size</p>
          <p className="page-subtitle mb-3">
            Adjust the overall type scale. Saved to this browser.
          </p>
          <DensityPickerClient />
        </div>
      </div>
    </div>
  );
}
