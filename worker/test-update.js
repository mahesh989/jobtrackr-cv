import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://ltcqqlfsomqxuwfcxxbe.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0Y3FxbGZzb21xeHV3ZmN4eGJlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODM1MTAzMSwiZXhwIjoyMDkzOTI3MDMxfQ.MI37g7BGmTqsmPjyqFrxy-OmojCLm8OEPZuCIbpOe3w";

const supabase = createClient(supabaseUrl, supabaseKey);

async function test() {
  const { data: jobs } = await supabase.from("jobs").select("id").limit(1);
  if (!jobs || jobs.length === 0) {
    console.log("No jobs found");
    return;
  }
  const jobId = jobs[0].id;
  console.log("Testing update on job", jobId);

  const { data, error } = await supabase
    .from("jobs")
    .update({ applied_at: new Date().toISOString() })
    .eq("id", jobId)
    .select();

  console.log("Result:", data, error);
}

test();
