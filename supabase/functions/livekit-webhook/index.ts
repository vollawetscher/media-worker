import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { WebhookReceiver } from "npm:livekit-server-sdk@2.15.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.text();
    const authHeader = req.headers.get("Authorization");

    // Get LiveKit Cloud server (the one sending webhooks)
    const { data: servers, error: serversError } = await supabase
      .from("livekit_servers")
      .select("id, name, server_url, api_key, api_secret")
      .eq("server_url", "wss://callassist-3wzky1ht.livekit.cloud")
      .maybeSingle();

    if (serversError || !servers) {
      console.error("Failed to fetch LiveKit server config:", serversError);
      return new Response(
        JSON.stringify({ error: "Server configuration not found" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const receiver = new WebhookReceiver(servers.api_key, servers.api_secret);
    const event = await receiver.receive(body, authHeader || "");

    console.log("Received webhook event:", event.event, "for room:", event.room?.name);

    if (event.event === "room_started" && event.room) {
      const { data: existingRoom } = await supabase
        .from("rooms")
        .select("id, status, closed_at")
        .eq("room_name", event.room.name)
        .maybeSingle();

      if (!existingRoom || existingRoom.closed_at !== null) {
        const { error: insertError } = await supabase
          .from("rooms")
          .insert({
            room_name: event.room.name,
            server_id: servers.id,
            organization_id: "00000000-0000-0000-0000-000000000000",
            status: "pending",
            ai_enabled: true,
            transcription_enabled: true,
            metadata: {
              livekit_room_sid: event.room.sid,
              created_via: "webhook",
            },
          });

        if (insertError) {
          console.error("Failed to create room:", insertError);
          return new Response(
            JSON.stringify({ error: "Failed to create room" }),
            {
              status: 500,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }

        console.log("Created room:", event.room.name);
      } else {
        console.log("Room already active:", event.room.name);
      }
    } else if (event.event === "participant_joined" && event.room) {
      const { error: updateError } = await supabase
        .from("rooms")
        .update({ status: "active" })
        .eq("room_name", event.room.name)
        .eq("status", "pending");

      if (updateError) {
        console.error("Failed to update room status:", updateError);
      } else {
        console.log("Updated room to active:", event.room.name);
      }
    } else if (event.event === "room_finished" && event.room) {
      // Get the room record first
      const { data: room, error: roomError } = await supabase
        .from("rooms")
        .select("id")
        .eq("room_name", event.room.name)
        .maybeSingle();

      if (roomError || !room) {
        console.error("Failed to find room:", roomError);
        return new Response(
          JSON.stringify({ error: "Room not found" }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Update room status to completed
      const { error: updateError } = await supabase
        .from("rooms")
        .update({
          status: "completed",
          closed_at: new Date().toISOString(),
        })
        .eq("room_name", event.room.name);

      if (updateError) {
        console.error("Failed to close room:", updateError);
      } else {
        console.log("Completed room:", event.room.name);
      }

      // Check if jobs already exist for this room (idempotency check)
      const { data: existingJobs } = await supabase
        .from("post_call_jobs")
        .select("id")
        .eq("room_id", room.id)
        .limit(1);

      if (existingJobs && existingJobs.length > 0) {
        console.log("Jobs already exist for room:", event.room.name, "skipping duplicate creation");
        return new Response(
          JSON.stringify({ success: true, event: event.event, skipped: "jobs_exist" }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Schedule post-call AI jobs
      const { data: transcripts } = await supabase
        .from("transcriptions")
        .select("*")
        .eq("room_id", room.id)
        .eq("is_final", true)
        .order("relative_timestamp", { ascending: true });

      if (!transcripts || transcripts.length === 0) {
        console.log("No transcripts found, skipping job creation");
        return new Response(
          JSON.stringify({ success: true, event: event.event }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const { data: participants } = await supabase
        .from("participants")
        .select("*")
        .eq("room_id", room.id);

      const { data: roomMetadata } = await supabase
        .from("rooms")
        .select("*")
        .eq("id", room.id)
        .maybeSingle();

      const inputData = {
        transcripts: transcripts,
        participants: participants || [],
        roomMetadata: roomMetadata || {},
      };

      const jobsToCreate = [
        { jobType: "summary", priority: 100 },
        { jobType: "action_items", priority: 90 },
        { jobType: "sentiment", priority: 70 },
        { jobType: "speaker_analytics", priority: 50 },
      ].map((job) => ({
        room_id: room.id,
        job_type: job.jobType,
        priority: job.priority,
        status: "pending",
        input_data: inputData,
      }));

      const { error: jobError } = await supabase
        .from("post_call_jobs")
        .insert(jobsToCreate);

      if (jobError) {
        console.error("Failed to create post-call jobs:", jobError);
      } else {
        console.log("Created post-call jobs for room:", event.room.name, "count:", jobsToCreate.length);
      }
    }

    return new Response(
      JSON.stringify({ success: true, event: event.event }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Webhook processing error:", error);
    return new Response(
      JSON.stringify({ error: "Invalid webhook", details: error.message }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});