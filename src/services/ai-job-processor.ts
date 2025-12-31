import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { getSupabase } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger({ component: 'AIJobProcessor' });

interface AIConfig {
  id: string;
  service_name: string;
  api_key: string;
  model_name: string;
  priority: number;
  prompt_template?: string;
  settings: Record<string, any>;
}

interface Job {
  id: string;
  room_id: string;
  job_type: string;
  input_data: any;
  organization_id?: string;
}

export class AIJobProcessor {
  private workerId: string;
  private pollingIntervalMs: number;
  private isRunning: boolean = false;
  private pollingTimer: NodeJS.Timeout | null = null;

  constructor(workerId: string, pollingIntervalMs: number = 5000) {
    this.workerId = workerId;
    this.pollingIntervalMs = pollingIntervalMs;
  }

  async start(): Promise<void> {
    logger.info({ workerId: this.workerId }, 'Starting AI job processor');
    this.isRunning = true;
    this.poll();
  }

  stop(): void {
    logger.info({ workerId: this.workerId }, 'Stopping AI job processor');
    this.isRunning = false;
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  private poll(): void {
    if (!this.isRunning) {
      return;
    }

    this.processNextJob()
      .catch((error) => {
        logger.error({ error }, 'Error processing job');
      })
      .finally(() => {
        this.pollingTimer = setTimeout(() => this.poll(), this.pollingIntervalMs);
      });
  }

  private async processNextJob(): Promise<void> {
    const job = await this.claimNextJob();

    if (!job) {
      return;
    }

    logger.info({ jobId: job.id, jobType: job.job_type, roomId: job.room_id }, 'Processing job');

    try {
      await this.updateJobStatus(job.id, 'processing');

      const result = await this.processJob(job);

      await this.completeJob(job.id, result);

      logger.info({ jobId: job.id, jobType: job.job_type }, 'Job completed successfully');
    } catch (error) {
      logger.error({ error, jobId: job.id, jobType: job.job_type }, 'Job processing failed');
      await this.failJob(job.id, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  private async claimNextJob(): Promise<Job | null> {
    const supabase = getSupabase();

    const { data: jobs, error } = await supabase
      .from('post_call_jobs')
      .select('id, room_id, job_type, input_data, priority, created_at')
      .eq('status', 'pending')
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1);

    if (error || !jobs || jobs.length === 0) {
      return null;
    }

    const job = jobs[0];

    const { error: claimError } = await supabase
      .from('post_call_jobs')
      .update({
        status: 'claimed',
        claimed_by_worker: this.workerId,
        claimed_at: new Date().toISOString(),
      })
      .eq('id', job.id)
      .eq('status', 'pending');

    if (claimError) {
      return null;
    }

    const { data: roomData } = await supabase
      .from('rooms')
      .select('organization_id')
      .eq('id', job.room_id)
      .single();

    return {
      ...job,
      organization_id: roomData?.organization_id,
    } as Job;
  }

  private async processJob(job: Job): Promise<any> {
    const prompt = this.buildPrompt(job);
    const configs = await this.loadAIConfigs();

    for (const config of configs) {
      try {
        const startTime = Date.now();
        const result = await this.callAI(config, prompt, job);
        const latency = Date.now() - startTime;

        await this.logAIInteraction(job, config, latency, result);

        return result;
      } catch (error) {
        logger.warn(
          {
            error,
            provider: config.service_name,
            jobId: job.id,
          },
          'AI provider failed, trying next'
        );
        continue;
      }
    }

    throw new Error('All AI providers failed');
  }

  private buildPrompt(job: Job): string {
    const { transcripts, participants } = job.input_data;

    const timeline = transcripts
      .map((t: any) => {
        const participant = participants.find((p: any) => p.id === t.participant_id);
        const speakerName = participant?.identity || 'Unknown';
        return `[${t.relative_timestamp.toFixed(1)}s] ${speakerName}: ${t.transcript_text}`;
      })
      .join('\n');

    const prompts: Record<string, string> = {
      summary: `Analyze the following conversation and provide a concise summary:\n\n${timeline}\n\nProvide a clear, structured summary of the conversation.`,
      action_items: `Extract action items from the following conversation:\n\n${timeline}\n\nList all action items, who they're assigned to, and any deadlines mentioned.`,
      sentiment: `Analyze the sentiment of the following conversation:\n\n${timeline}\n\nProvide overall sentiment, key emotional moments, and sentiment per participant.`,
      speaker_analytics: `Analyze speaker behavior in the following conversation:\n\n${timeline}\n\nProvide insights on speaking time, speaking style, engagement level, and interaction patterns for each participant.`,
    };

    return prompts[job.job_type] || timeline;
  }

  private async callAI(config: AIConfig, prompt: string, job: Job): Promise<any> {
    if (config.service_name.toLowerCase().includes('openai')) {
      return await this.callOpenAI(config, prompt);
    } else if (config.service_name.toLowerCase().includes('anthropic')) {
      return await this.callAnthropic(config, prompt);
    }

    throw new Error(`Unknown AI provider: ${config.service_name}`);
  }

  private async callOpenAI(config: AIConfig, prompt: string): Promise<any> {
    const client = new OpenAI({ apiKey: config.api_key });

    const response = await client.chat.completions.create({
      model: config.model_name,
      messages: [{ role: 'user', content: prompt }],
      temperature: config.settings?.temperature || 0.7,
      max_tokens: config.settings?.max_tokens || 2000,
    });

    return {
      provider: 'openai',
      model: config.model_name,
      content: response.choices[0]?.message?.content || '',
      promptTokens: response.usage?.prompt_tokens || 0,
      completionTokens: response.usage?.completion_tokens || 0,
      totalTokens: response.usage?.total_tokens || 0,
    };
  }

  private async callAnthropic(config: AIConfig, prompt: string): Promise<any> {
    const client = new Anthropic({ apiKey: config.api_key });

    const response = await client.messages.create({
      model: config.model_name,
      max_tokens: config.settings?.max_tokens || 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0];
    const text = content.type === 'text' ? content.text : '';

    return {
      provider: 'anthropic',
      model: config.model_name,
      content: text,
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    };
  }

  private async loadAIConfigs(): Promise<AIConfig[]> {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('ai_config')
      .select('*')
      .eq('is_active', true)
      .order('priority', { ascending: false });

    if (error || !data) {
      throw new Error('No active AI configurations found');
    }

    return data as AIConfig[];
  }

  private async logAIInteraction(job: Job, config: AIConfig, latencyMs: number, result: any): Promise<void> {
    if (!job.organization_id) {
      logger.warn({ jobId: job.id, roomId: job.room_id }, 'Cannot log AI interaction: organization_id missing');
      return;
    }

    const supabase = getSupabase();

    await supabase.from('ai_interactions').insert({
      room_id: job.room_id,
      organization_id: job.organization_id,
      job_id: job.id,
      interaction_type: 'llm',
      provider: result.provider,
      model: result.model,
      prompt_tokens: result.promptTokens,
      completion_tokens: result.completionTokens,
      total_tokens: result.totalTokens,
      latency_ms: latencyMs,
    });
  }

  private async updateJobStatus(jobId: string, status: string): Promise<void> {
    const supabase = getSupabase();

    await supabase
      .from('post_call_jobs')
      .update({
        status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  }

  private async completeJob(jobId: string, result: any): Promise<void> {
    const supabase = getSupabase();

    await supabase
      .from('post_call_jobs')
      .update({
        status: 'completed',
        output_data: { result: result.content, metadata: result },
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  }

  private async failJob(jobId: string, errorMessage: string): Promise<void> {
    const supabase = getSupabase();

    const { data: job } = await supabase.from('post_call_jobs').select('retry_count').eq('id', jobId).single();

    const retryCount = (job?.retry_count || 0) + 1;
    const maxRetries = 3;

    if (retryCount < maxRetries) {
      await supabase
        .from('post_call_jobs')
        .update({
          status: 'pending',
          retry_count: retryCount,
          error_message: errorMessage,
          claimed_by_worker: null,
          claimed_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);
    } else {
      await supabase
        .from('post_call_jobs')
        .update({
          status: 'failed',
          retry_count: retryCount,
          error_message: errorMessage,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);
    }
  }
}
