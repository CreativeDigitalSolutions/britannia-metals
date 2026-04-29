/**
 * Shared Supabase client factory for Britannia Metals Edge Functions.
 * Uses the service role key — intended only for server-side Edge Functions.
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically
 * by the Supabase Edge Function runtime; no .env configuration needed.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';

export function createSupabaseServiceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}
