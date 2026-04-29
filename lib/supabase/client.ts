import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

// For use in browser (Client Components) — uses anon key, RLS enforced
export function getSupabaseClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
