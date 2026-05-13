import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://ltcqqlfsomqxuwfcxxbe.supabase.co";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0Y3FxbGZzb21xeHV3ZmN4eGJlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODM1MTAzMSwiZXhwIjoyMDkzOTI3MDMxfQ.MI37g7BGmTqsmPjyqFrxy-OmojCLm8OEPZuCIbpOe3w";

const supabase = createClient(supabaseUrl, supabaseKey);

async function fixDeadLinks() {
  const { data, error, count } = await supabase
    .from("jobs")
    .update({ is_dead_link: false })
    .eq("is_dead_link", true)
    .eq("source", "adzuna")
    .select("id");

  if (error) {
    console.error("Error fixing links:", error);
  } else {
    console.log(`Fixed ${data?.length || 0} Adzuna jobs that were falsely marked as dead links!`);
  }
}

fixDeadLinks();
