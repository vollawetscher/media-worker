import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const url = new URL(req.url);
    const query = url.searchParams.get('query');

    let data, error;

    switch (query) {
      case 'jobs':
        ({ data, error } = await supabase
          .from('post_call_jobs')
          .select('id, job_type, status, priority, created_at, claimed_by_worker, claimed_at, retry_count, error_message')
          .order('created_at', { ascending: false })
          .limit(20));
        break;

      case 'ai_config':
        ({ data, error } = await supabase
          .from('ai_config')
          .select('id, service_name, model_name, priority, is_active, use_case, created_at')
          .order('priority', { ascending: false }));
        break;

      case 'ai_config_keys':
        ({ data, error } = await supabase
          .from('ai_config')
          .select('id, service_name, api_key, model_name, priority, is_active')
          .order('priority', { ascending: false }));

        if (data) {
          data = data.map((config: any) => ({
            ...config,
            api_key_present: config.api_key ? true : false,
            api_key_length: config.api_key ? config.api_key.length : 0,
            api_key: undefined,
          }));
        }
        break;

      case 'ai_interactions':
        ({ data, error } = await supabase
          .from('ai_interactions')
          .select('id, provider, model, job_id, created_at, metadata')
          .order('created_at', { ascending: false })
          .limit(20));
        break;

      case 'workers':
        ({ data, error } = await supabase
          .from('media_workers')
          .select('id, mode, status, last_heartbeat, created_at')
          .order('last_heartbeat', { ascending: false })
          .limit(20));
        break;

      case 'ai_workers':
        ({ data, error } = await supabase
          .from('media_workers')
          .select('id, mode, status, last_heartbeat, created_at')
          .or('mode.eq.ai-jobs,mode.eq.both')
          .order('created_at', { ascending: false })
          .limit(50));
        break;

      default:
        return new Response(
          JSON.stringify({ error: 'Invalid query parameter. Use: jobs, ai_config, ai_config_keys, ai_interactions, workers, or ai_workers' }),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
    }

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response(
      JSON.stringify({ data }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});