import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { WorkerConfig } from '../config/index.js';

let supabaseClient: SupabaseClient | null = null;

export function initSupabase(config: WorkerConfig): SupabaseClient {
  if (!supabaseClient) {
    supabaseClient = createClient(
      config.supabase.url,
      config.supabase.serviceRoleKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    );
  }
  return supabaseClient;
}

export function getSupabase(): SupabaseClient {
  if (!supabaseClient) {
    throw new Error('Supabase client not initialized. Call initSupabase first.');
  }
  return supabaseClient;
}
