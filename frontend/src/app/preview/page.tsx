import { redirect } from "next/navigation";

import { PreviewScreen } from "@/components/PreviewScreen";
import { createClient } from "@/lib/supabase/server";

export default async function PreviewPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/preview");
  }

  return <PreviewScreen />;
}
