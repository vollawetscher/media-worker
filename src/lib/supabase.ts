import { createClient, SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import type { WorkerConfig } from '../config/index.js';
import { logger } from './logger.js';

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
        realtime: {
          transport: WebSocket as any,
          timeout: config.realtimeTimeoutMs,
          params: {
            eventsPerSecond: 10,
          },
        },
        global: {
          headers: {
            'X-Worker-ID': config.workerId,
          },
        },
      }
    );

    logger.info({
      workerId: config.workerId,
      realtimeTimeout: config.realtimeTimeoutMs,
      enablePollingFallback: config.enablePollingFallback,
      enableDatabaseNotify: config.enableDatabaseNotify,
    }, 'Supabase client initialized');
  }
  return supabaseClient;
}

export function getSupabase(): SupabaseClient {
  if (!supabaseClient) {
    throw new Error('Supabase client not initialized. Call initSupabase first.');
  }
  return supabaseClient;
}
