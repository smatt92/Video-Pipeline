import 'server-only';

import type { Db } from '../db/server';
import { readTranscript, type TranscriptEntry } from './session';

/**
 * What the Studio screens read.
 *
 * Separate from `session.ts` so the read path carries no Anthropic import — a list of
 * sessions should not pull an SDK into the page's bundle graph — and so the three-outcome
 * rule the board established holds here too: rows, empty, or broken. A screen that renders
 * an empty list when the query failed makes the failure invisible.
 */

export interface SessionSummary {
  id: string;
  title: string | null;
  status: string;
  stoppedReason: string | null;
  model: string;
  scriptId: string | null;
  spendCapInr: number | null;
  costInr: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  ledgerRows: number;
  createdAt: string;
}

export type SessionList =
  | { ok: true; sessions: SessionSummary[] }
  | { ok: false; detail: string };

export async function listSessions(db: Db): Promise<SessionList> {
  const { data, error } = await db
    .from('v_studio_session_spend')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return { ok: false, detail: error.message };

  return {
    ok: true,
    sessions: (data ?? []).map((r) => ({
      id: String(r.session_id),
      title: r.title,
      status: String(r.status),
      stoppedReason: r.stopped_reason,
      model: String(r.model),
      scriptId: r.script_id,
      spendCapInr: r.spend_cap_inr === null ? null : Number(r.spend_cap_inr),
      costInr: Number(r.cost_inr ?? 0),
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      turns: Number(r.turns ?? 0),
      ledgerRows: Number(r.ledger_rows ?? 0),
      createdAt: String(r.created_at),
    })),
  };
}

export interface SessionDetail {
  summary: SessionSummary;
  transcript: TranscriptEntry[];
  script: {
    id: string;
    conceptId: string;
    hook: string;
    voText: string;
    draftedBy: string;
    humanEditCount: number;
  } | null;
  shots: {
    id: string;
    idx: number;
    description: string;
    durationS: number;
    status: string;
  }[];
  ledger: { unit: string; quantity: number; costInr: number; occurredAt: string }[];
}

export type SessionRead = { ok: true; detail: SessionDetail } | { ok: false; detail: string };

export async function readSession(db: Db, sessionId: string): Promise<SessionRead> {
  const { data: row, error } = await db
    .from('v_studio_session_spend')
    .select('*')
    .eq('session_id', sessionId)
    .maybeSingle();

  if (error) return { ok: false, detail: error.message };
  if (!row) return { ok: false, detail: `No session ${sessionId}.` };

  const { data: session } = await db
    .from('studio_sessions')
    .select('transcript')
    .eq('id', sessionId)
    .maybeSingle();

  const scriptId = row.script_id;

  const { data: script } = scriptId
    ? await db
        .from('scripts')
        .select('id, concept_id, hook, vo_text, drafted_by, human_edit_count')
        .eq('id', scriptId)
        .maybeSingle()
    : { data: null };

  const { data: shots } = scriptId
    ? await db
        .from('shots')
        .select('id, idx, description, duration_s, status')
        .eq('script_id', scriptId)
        .order('idx')
    : { data: [] };

  const { data: ledger } = await db
    .from('cost_ledger')
    .select('unit, quantity, cost_inr, occurred_at')
    .eq('studio_session_id', sessionId)
    .order('occurred_at', { ascending: false })
    .limit(40);

  return {
    ok: true,
    detail: {
      summary: {
        id: String(row.session_id),
        title: row.title,
        status: String(row.status),
        stoppedReason: row.stopped_reason,
        model: String(row.model),
        scriptId,
        spendCapInr: row.spend_cap_inr === null ? null : Number(row.spend_cap_inr),
        costInr: Number(row.cost_inr ?? 0),
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        turns: Number(row.turns ?? 0),
        ledgerRows: Number(row.ledger_rows ?? 0),
        createdAt: String(row.created_at),
      },
      transcript: readTranscript(session?.transcript),
      script: script
        ? {
            id: script.id,
            conceptId: script.concept_id,
            hook: script.hook,
            voText: script.vo_text,
            draftedBy: script.drafted_by,
            humanEditCount: script.human_edit_count,
          }
        : null,
      shots: (shots ?? []).map((s) => ({
        id: s.id,
        idx: s.idx,
        description: s.description,
        durationS: Number(s.duration_s),
        status: s.status,
      })),
      ledger: (ledger ?? []).map((l) => ({
        unit: l.unit,
        quantity: Number(l.quantity),
        costInr: Number(l.cost_inr ?? 0),
        occurredAt: String(l.occurred_at),
      })),
    },
  };
}
