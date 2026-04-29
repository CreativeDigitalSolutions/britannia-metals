import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

// For use in Server Components only — uses anon key, RLS enforced
export function getSupabaseServer() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  );
}
