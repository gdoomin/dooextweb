import { redirect } from "next/navigation";

import { PreviewScreen } from "@/components/PreviewScreen";
import { getUser, isSupabaseConfigured } from "@/lib/supabase/server";

export default async function PreviewPage() {
  if (!isSupabaseConfigured()) {
    redirect("/login?next=/preview");
  }

  const user = await getUser();

  if (!user) {
    redirect("/login?next=/preview");
  }

  return <PreviewScreen />;
}
