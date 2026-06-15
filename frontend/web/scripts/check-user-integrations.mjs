import { createClient } from "@supabase/supabase-js";

const url = "https://ltcqqlfsomqxuwfcxxbe.supabase.co";
const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0Y3FxbGZzb21xeHV3ZmN4eGJlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODM1MTAzMSwiZXhwIjoyMDkzOTI3MDMxfQ.MI37g7BGmTqsmPjyqFrxy-OmojCLm8OEPZuCIbpOe3w";

async function main() {
  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: users } = await supabase
    .from("users")
    .select("id, email")
    .eq("email", "rashmipoudel756@gmail.com");

  if (!users || users.length === 0) {
    console.error("User not found");
    return;
  }

  const userId = users[0].id;
  console.log(`User ID: ${userId}`);

  const { data: integrations, error } = await supabase
    .from("user_integrations")
    .select("provider, status, is_enabled, config")
    .eq("user_id", userId);

  if (error) {
    console.error("Error fetching integrations:", error);
    return;
  }

  console.log("Connected Integrations:");
  console.log(JSON.stringify(integrations, null, 2));
}

main();
