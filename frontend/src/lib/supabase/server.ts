import { createServerClient } from "@supabase/ssr";
import type { User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { getSupabaseConfig } from "./config";

export { isSupabaseConfigured } from "./config";


export async function createClient() {
  const cookieStore = await cookies();
  const config = getSupabaseConfig();
  if (!config) {
    return null;
  }

  return createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components can read cookies but may not be allowed to mutate them.
        }
      },
    },
  });
}

export async function getUser(): Promise<User | null> {
  const supabase = await createClient();
  if (!supabase) {
    return null;
  }

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user;
  } catch {
    return null;
  }
}
