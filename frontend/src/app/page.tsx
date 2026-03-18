import { HomeScreen } from "@/components/HomeScreen";
import { createClient } from "@/lib/supabase/server";

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return <HomeScreen initialUserEmail={user?.email || ""} />;
}
