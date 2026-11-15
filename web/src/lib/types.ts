import type { WizardRecord } from "@/lib/wizards/engine";

// Контракт API (Go-служба backend/, ответ строит ядро scripts/core_api.py). Поля — как в JSON сервера.
import type { RoleId, RoleSource } from "./roles";

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

/** Раздел базы, на который опирается «честное нет» (T26): ссылка /kb?chunk=<chunk_id>. */
export interface HonestNoSection {
  chunk_id: string;
  doc: string;
  title: string;
  path: string;
}

/**
 * «Честное нет» (T26): продукт клиенту, скорее всего, не подойдёт по условию из базы.
 * reason и alternative.text — дословный текст раздела базы; fact — фрагмент реплики клиента, по которому сработало.
 */
export interface HonestNo {
  rule: string;
  product: string;
  reason: string;
  fact: string;
  section: HonestNoSection | null;
  alternative: { text: string; section: HonestNoSection | null } | null;
}

export interface AnswerPayload {
  id: string;
  /** answer — обычный ответ, clarify — уточняющий вопрос ниже порога уверенности (T12). */
  route?: "answer" | "clarify";
  text: string;
  fallback: boolean;
  error: string;
  mode: ChatMode;
  /** Роль-подсказка, с которой ядро собрало промпт (T15); пусто — без неё. */
  role?: string;
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
  /** «Честные нет» (T26): только режим chat; в eval и copilot — пусто. */
  honest_no?: HonestNo[];
  /** T13: ответ печатался дельтами по мере генерации. */
  streamed?: boolean;
  /** T13: финальный текст отличается от напечатанного — проверка ответа переписала или вырезала часть. */
  revised?: boolean;
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

/** GET /api/ocr — что принимается из документов клиента (T9). */
export interface OcrInfo {
  /** Кнопка вложения активна: задана vision-модель (EB_VISION_MODEL). */
  enabled: boolean;
  photos: boolean;
  pdf: boolean;
  types: string[];
  max_bytes: number;
  max_pages: number;
}

/** POST /api/ocr — текст документа на проверку клиенту. Файл на сервере не хранится. */
export interface OcrResult {
  text: string;
  kind: "pdf" | "jpeg" | "png" | "webp";
  /** text_layer — PDF без модели, vision — фото через vision-модель (только OCR). */
  source: "text_layer" | "vision";
  pages?: number;
  pages_read?: number;
  truncated: boolean;
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
  /** Текст, напечатанный дельтами, пока ответ не готов (T13). Живёт только в памяти, в localStorage не пишется. */
  streamed?: string;
  /** Ответ печатался на глазах — готовый текст не проявляется заново. */
  typed?: boolean;
  /** Финальный текст заменил напечатанный — метка «Уточнено проверкой». */
  revised?: boolean;
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
  /** Пройденный мастер (T7): итог пересчитывается по ответам, паспорт получает их после первого ответа бота. */
  wizard?: WizardRecord;
  /**
   * Роль-подсказка (T15): кто, вероятно, пишет. Пусто при roleSource "client" — клиент сам снял подсказку,
   * автоопределение её не вернёт. Уходит на сервер с каждым вопросом режима chat.
   */
  role?: RoleId | "";
  roleSource?: RoleSource;
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
