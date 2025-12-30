import { createClient } from '@supabase/supabase-js';
let supabaseClient = null;
export function initSupabase(config) {
    if (!supabaseClient) {
        supabaseClient = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
            auth: {
                autoRefreshToken: false,
                persistSession: false,
            },
        });
    }
    return supabaseClient;
}
export function getSupabase() {
    if (!supabaseClient) {
        throw new Error('Supabase client not initialized. Call initSupabase first.');
    }
    return supabaseClient;
}
//# sourceMappingURL=supabase.js.map