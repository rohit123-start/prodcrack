import crypto from 'crypto'
import { getSupabaseAdmin } from '@/lib/server/supabase-admin'

export type IngestionLogStatus = 'started' | 'success' | 'failed' | 'skipped'

export type IngestionLogEntry = {
  timestamp: string
  repository_id: string
  orchestrator_state: string
  agent_name: string
  step: string
  status: IngestionLogStatus
  input_summary: Record<string, unknown>
  output_summary: Record<string, unknown>
  error_message?: string
}

export class IngestionLogger {
  private readonly repositoryId: string
  private readonly persistToSupabase: boolean
  private ingestionLogsUnavailable = false

  constructor(repositoryId: string, persistToSupabase = true) {
    this.repositoryId = repositoryId
    this.persistToSupabase = persistToSupabase
  }

  private formatSummary(summary: Record<string, unknown>) {
    const entries = Object.entries(summary)
    if (entries.length === 0) return 'none'
    return entries
      .slice(0, 12)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(', ')
  }

  async log(params: {
    orchestratorState: string
    agentName: string
    step: string
    status: IngestionLogStatus
    inputSummary?: Record<string, unknown>
    outputSummary?: Record<string, unknown>
    errorMessage?: string
  }) {
    const entry: IngestionLogEntry = {
      timestamp: new Date().toISOString(),
      repository_id: this.repositoryId,
      orchestrator_state: params.orchestratorState,
      agent_name: params.agentName,
      step: params.step,
      status: params.status,
      input_summary: params.inputSummary || {},
      output_summary: params.outputSummary || {},
      ...(params.errorMessage ? { error_message: params.errorMessage } : {}),
    }

    // Human-readable conversational logs for debugging in terminal.
    console.log(
      `[${entry.agent_name}] ${entry.status.toUpperCase()} ${entry.step} (state=${entry.orchestrator_state}, repo=${entry.repository_id})`
    )
    console.log(`  input: ${this.formatSummary(entry.input_summary)}`)
    console.log(`  output: ${this.formatSummary(entry.output_summary)}`)
    if (entry.error_message) {
      console.log(`  error: ${entry.error_message}`)
    }

    if (!this.persistToSupabase || this.ingestionLogsUnavailable) return

    try {
      const supabase = getSupabaseAdmin()
      const { error } = await supabase.from('ingestion_logs').insert({
        id: crypto.randomUUID(),
        repository_id: entry.repository_id,
        agent_name: entry.agent_name,
        step: entry.step,
        status: entry.status,
        input_summary: entry.input_summary,
        output_summary: entry.output_summary,
        error_message: entry.error_message || null,
      })

      if (error) {
        if (error.message?.toLowerCase().includes('relation "ingestion_logs" does not exist')) {
          this.ingestionLogsUnavailable = true
          return
        }
        console.warn('ingestion_logs insert failed:', error.message)
      }
    } catch (error) {
      console.warn('ingestion_logs insert failed:', error instanceof Error ? error.message : String(error))
    }
  }
}
