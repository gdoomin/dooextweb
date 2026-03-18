type SupabaseConfig = {
  url: string;
  anonKey: string;
};

function isPlaceholder(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return normalized.includes("여기에") || normalized.includes("supabase url") || normalized.includes("anon key");
}

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function getSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";

  if (isPlaceholder(url) || isPlaceholder(anonKey) || !isHttpUrl(url)) {
    return null;
  }

  return { url, anonKey };
}

export function isSupabaseConfigured() {
  return getSupabaseConfig() !== null;
}
