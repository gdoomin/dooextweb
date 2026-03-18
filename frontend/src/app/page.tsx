import { HomeScreen } from "@/components/HomeScreen";
import { getUser, isSupabaseConfigured } from "@/lib/supabase/server";

export default async function HomePage() {
  const user = await getUser();

  return (
    <HomeScreen
      initialUserEmail={user?.email || ""}
      initialUserId={user?.id || ""}
      authAvailable={isSupabaseConfigured()}
    />
  );
}
