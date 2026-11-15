// Схема отчёта eval/personas.py (schema "personas/v1"). Отчёт кладётся рядом — personas-latest.json —
// командой `eval/personas.py --real --publish`; пока прогона не было, там заглушка {"status": "not-run"}.

export type LeadStatus = "timely" | "early" | "missing" | "none_ok" | "extra";

export interface LlmCalls {
  chat: number;
  embed: number;
  rerank: number;
}

export interface Summary {
  scenarios: number;
  turns: number;
  clean_numbers_rate: number | null;
  question_rate: number | null;
  first_reply_question_rate: number | null;
  lead: Record<LeadStatus, number>;
  lead_ok_rate: number | null;
  fallback_rate: number | null;
  guard_fired_rate: number | null;
  llm_calls: LlmCalls;
  passport_fill: number | null;
  passport_fill_note: string;
}

export interface PersonaSummary extends Summary {
  persona: string;
  name: string;
}

export interface Turn {
  n: number;
  client: string;
  bot: string;
  asked_question: boolean;
  lead_offer: boolean;
  unknown_numbers: string[];
  guard: Record<string, unknown>;
  fallback: boolean;
  error: string;
  sources: { doc: string; chunk_id: string | null; whole: boolean }[];
  llm_calls: LlmCalls;
  ms: number;
}

export interface Dialog {
  id: string;
  persona: string;
  title: string;
  lead: { status: LeadStatus; first_offer_turn: number | null; context_turn: number; expected: boolean };
  passport_fill: number | null;
  turns: Turn[];
}

export interface PersonasReport {
  schema: "personas/v1";
  mock: boolean;
  created_at: string;
  commit: string;
  model: string;
  config: { mode: string; arch: string; style: string; search: string; dense: boolean; reranker: boolean };
  scenarios_file: string;
  duration_sec: number;
  heuristics: Record<string, string>;
  totals: Summary;
  personas: PersonaSummary[];
  dialogs: Dialog[];
}

export const RUN_COMMAND = "set -a; source .env; set +a\n.venv/bin/python eval/personas.py --real --publish";
export const MOCK_COMMAND = ".venv/bin/python eval/personas.py --mock";

/** Отчёт ли это нужной схемы, а не заглушка «прогона ещё не было». */
export function isReport(data: unknown): data is PersonasReport {
  if (!data || typeof data !== "object") return false;
  const r = data as Partial<PersonasReport>;
  return r.schema === "personas/v1" && Array.isArray(r.personas) && Array.isArray(r.dialogs) && !!r.totals;
}
