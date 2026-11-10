// Контракт API (Go-служба backend/, ответ строит ядро scripts/core_api.py). Поля — как в JSON сервера.

export type Role = "user" | "assistant";

export interface Turn {
  role: Role;
  content: string;
}

export type ChatMode = "chat" | "eval";

export interface Hit {
  rank: number;
  id: string;
  doc: string;
  title: string;
  path: string;
  score: number | null;
  stage: "bm25" | "rrf" | "rerank" | string;
  in_context: boolean;
  preview: string;
}

export interface Retrieval {
  arch: string;
  dense: boolean;
  queries: { lexical?: string; semantic?: string; last?: string };
  hits: Hit[];
  context: { full_docs: string[]; chunk_ids: string[]; chars: number };
}

export interface Support {
  id: string;
  doc: string;
  path: string;
  title?: string;
  overlap: number;
  numbers: string[];
}

export interface Citation {
  sentence: string;
  question: boolean;
  support: Support[];
  unsupported_numbers: string[];
}

export interface Source {
  kind: "doc" | "chunk";
  doc: string;
  title: string;
  path?: string;
  chunk_id: string | null;
}

export interface Guard {
  unknown_numbers?: string[];
  too_long?: boolean;
  repaired?: boolean;
  stripped?: string[];
  dropped?: string[];
  refined?: boolean;
  repair_error?: string;
  [key: string]: unknown;
}

export interface AnswerPayload {
  id: string;
  text: string;
  fallback: boolean;
  error: string;
  mode: ChatMode;
  timings: Record<string, number>;
  guard: Guard;
  trace: string;
  sources: Source[];
  citations: Citation[];
  retrieval: Retrieval | null;
  prompt: { role: string; content: string }[];
  prompt_chars: number;
  llm_calls?: LlmCall[];
  model: string;
}

export interface LlmCall {
  ms: number;
  prompt_chars: number;
  instruction: string;
  output: string;
  error: string;
}

export interface Health {
  ok: boolean;
  arch: string;
  llm: boolean;
  model: string;
  dense: boolean;
  reranker: boolean;
  chunks: number;
  docs: number;
  kb_fingerprint: string;
  mode: ChatMode;
}

export interface KbChunk {
  id: string;
  order: number;
  path: string;
  text: string;
  links: string[];
  is_guard: boolean;
  is_reference: boolean;
}

export interface KbDoc {
  doc: string;
  title: string;
  group: string;
  chunks: KbChunk[];
}

export interface KbData {
  fingerprint: string;
  docs: KbDoc[];
}

// ---------- клиентская модель ----------
export type Stage = "retrieval" | "generation" | "done";

export interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  pending?: boolean;
  stage?: Stage;
  retrieval?: Retrieval | null;
  answer?: AnswerPayload;
  error?: string;
  rating?: 1 | -1;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  lead?: { id: string; summary: string };
}
