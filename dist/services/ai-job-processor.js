import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { getSupabase } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
const logger = createLogger({ component: 'AIJobProcessor' });
export class AIJobProcessor {
    workerId;
    pollingIntervalMs;
    isRunning = false;
    pollingTimer = null;
    constructor(workerId, pollingIntervalMs = 5000) {
        this.workerId = workerId;
        this.pollingIntervalMs = pollingIntervalMs;
    }
    async start() {
        logger.info({ workerId: this.workerId }, 'Starting AI job processor');
        this.isRunning = true;
        this.poll();
    }
    stop() {
        logger.info({ workerId: this.workerId }, 'Stopping AI job processor');
        this.isRunning = false;
        if (this.pollingTimer) {
            clearTimeout(this.pollingTimer);
            this.pollingTimer = null;
        }
    }
    poll() {
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
    async processNextJob() {
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
        }
        catch (error) {
            logger.error({ error, jobId: job.id, jobType: job.job_type }, 'Job processing failed');
            await this.failJob(job.id, error instanceof Error ? error.message : 'Unknown error');
        }
    }
    async claimNextJob() {
        const supabase = getSupabase();
        const { data: jobs, error } = await supabase
            .from('post_call_jobs')
            .select('*')
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
        return job;
    }
    async processJob(job) {
        const prompt = this.buildPrompt(job);
        const configs = await this.loadAIConfigs();
        for (const config of configs) {
            try {
                const startTime = Date.now();
                const result = await this.callAI(config, prompt, job);
                const latency = Date.now() - startTime;
                await this.logAIInteraction(job, config, latency, result);
                return result;
            }
            catch (error) {
                logger.warn({
                    error,
                    provider: config.service_name,
                    jobId: job.id,
                }, 'AI provider failed, trying next');
                continue;
            }
        }
        throw new Error('All AI providers failed');
    }
    buildPrompt(job) {
        const { transcripts, participants } = job.input_data;
        const timeline = transcripts
            .map((t) => {
            const participant = participants.find((p) => p.id === t.participant_id);
            const speakerName = participant?.identity || 'Unknown';
            return `[${t.relative_timestamp.toFixed(1)}s] ${speakerName}: ${t.transcript_text}`;
        })
            .join('\n');
        const prompts = {
            summary: `Analyze the following conversation and provide a concise summary:\n\n${timeline}\n\nProvide a clear, structured summary of the conversation.`,
            action_items: `Extract action items from the following conversation:\n\n${timeline}\n\nList all action items, who they're assigned to, and any deadlines mentioned.`,
            sentiment: `Analyze the sentiment of the following conversation:\n\n${timeline}\n\nProvide overall sentiment, key emotional moments, and sentiment per participant.`,
            speaker_analytics: `Analyze speaker behavior in the following conversation:\n\n${timeline}\n\nProvide insights on speaking time, speaking style, engagement level, and interaction patterns for each participant.`,
        };
        return prompts[job.job_type] || timeline;
    }
    async callAI(config, prompt, job) {
        if (config.service_name.toLowerCase().includes('openai')) {
            return await this.callOpenAI(config, prompt);
        }
        else if (config.service_name.toLowerCase().includes('anthropic')) {
            return await this.callAnthropic(config, prompt);
        }
        throw new Error(`Unknown AI provider: ${config.service_name}`);
    }
    async callOpenAI(config, prompt) {
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
    async callAnthropic(config, prompt) {
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
    async loadAIConfigs() {
        const supabase = getSupabase();
        const { data, error } = await supabase
            .from('ai_config')
            .select('*')
            .eq('is_active', true)
            .order('priority', { ascending: false });
        if (error || !data) {
            throw new Error('No active AI configurations found');
        }
        return data;
    }
    async logAIInteraction(job, config, latencyMs, result) {
        const supabase = getSupabase();
        await supabase.from('ai_interactions').insert({
            room_id: job.room_id,
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
    async updateJobStatus(jobId, status) {
        const supabase = getSupabase();
        await supabase
            .from('post_call_jobs')
            .update({
            status,
            updated_at: new Date().toISOString(),
        })
            .eq('id', jobId);
    }
    async completeJob(jobId, result) {
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
    async failJob(jobId, errorMessage) {
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
        }
        else {
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
//# sourceMappingURL=ai-job-processor.js.map