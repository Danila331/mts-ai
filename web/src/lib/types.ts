// Контракт API (Go-служба backend/, ответ строит ядро scripts/core_api.py). Поля — как в JSON сервера.

export type Role = "user" | "assistant";

export interface Turn {
  role: Role;
  content: string;
}

/** chat — клиент на сайте, eval — как автопроверка, copilot — менеджер МТС спрашивает базу (T11). */
export type ChatMode = "chat" | "eval" | "copilot";

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

/** Из чего сложилась уверенность (T12): retrieval — по выдаче поиска до генерации, support — по опоре ответа. */
export interface ConfidencePart {
  key: "lexical" | "rerank" | "support" | string;
  part: "retrieval" | "support";
  label: string;
  value: number;
  detail?: string;
}

export interface Confidence {
  /** Итог 0..1: среднее поиска и опоры (только поиск, если опору считать не по чему). */
  score: number;
  /** Порог EB_CONFIDENCE_THRESHOLD; сравнивается с retrieval до генерации. */
  threshold: number;
  retrieval: number;
  support: number | null;
  stage: "bm25" | "rrf" | "rerank" | "none" | string;
  parts: ConfidencePart[];
  /** Порог применялся к этому ответу: режим chat и EB_CONFIDENCE_GATE=1. */
  gate: boolean;
  /** Поиск ниже порога — вместо ответа уточняющий вопрос. */
  gated: boolean;
  explain: string;
}

export interface AnswerPayload {
  id: string;
  /** answer — обычный ответ, clarify — уточняющий вопрос ниже порога уверенности (T12). */
  route?: "answer" | "clarify";
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
  /** Настройки песочницы, с которыми построен этот ответ; пусто — общие настройки стенда. */
  overrides?: Record<string, SettingValue>;
  confidence?: Confidence;
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
  confidence_gate?: boolean;
  confidence_threshold?: number;
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

// ---------- паспорт задачи (T2, событие passport и PATCH /api/sessions/:id/passport) ----------
export type PassportGroup = "general" | "wholesale" | "solar" | "platform" | "losses" | "recognition" | "contacts";

export interface PassportField {
  key: string;
  label: string;
  group: PassportGroup;
  options?: string[];
  value?: string;
  /** bot — понял бот из реплик клиента, client — клиент заполнил сам. */
  source?: "bot" | "client";
}

export interface Passport {
  fields: PassportField[];
  product_candidates: { product: PassportGroup; sections: string[] }[];
  product: PassportGroup;
  product_label: string;
  filled: number;
  total: number;
  handoff_agreed: boolean;
  /** Есть имя, телефон и компания или клиент согласился на передачу — показать карточку заявки. */
  ready_for_lead: boolean;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  lead?: { id: string; summary: string };
  passport?: Passport;
}

// ---------- настройки RAG (GET/POST /api/settings) ----------

export type SettingValue = number | boolean | string;

export interface SettingField {
  key: string;
  group: "search" | "generation";
  kind: "int" | "float" | "bool" | "enum";
  /** Переменная окружения ядра, из которой взято значение по умолчанию. */
  env: string;
  /** false — включить нельзя: нет индекса эмбеддингов, не настроена модель и т. п. */
  available: boolean;
  min?: number;
  max?: number;
  /** Потолок песочницы для полей, от которых растёт цена ответа (контекст, токены). */
  sandbox_max?: number;
  options?: (string | number)[];
}

export interface RagSettings {
  fields: SettingField[];
  values: Record<string, SettingValue>;
  /** Значения из окружения ядра — к ним ведёт «Сбросить к окружению». */
  defaults: Record<string, SettingValue>;
  changed: string[];
  model: string;
  /** Unix-время последнего сохранения; null — действуют значения из окружения. */
  updated_at: number | null;
}
