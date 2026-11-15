/**
 * UX ответа и диалога (T31): метка ИИ, быстрые ответы, тексты после заявки, правила прокрутки и «нового диалога».
 *
 * Чистый модуль без React и сети (тесты: answer-ux.test.ts). Факты о продуктах здесь не появляются: чек-лист
 * «что подготовить» берётся из consultation-summary.ts (цитаты раздела базы, их сверяет тест T10), а тексты
 * про заявку не называют срок и не обещают время звонка (docs/ROADMAP.md, раздел 0, п. 5).
 */
import { buildSummary, type KbLike, type SummaryChecklist } from "./consultation-summary.ts";
import type { AnswerPayload, Message, Passport, Session } from "./types.ts";

// ---------- метка «ИИ-ассистент» ----------

export const AI_LABEL = "ИИ-ассистент";
export const AI_DISCLAIMER = "Ответы основаны на материалах EnergyTool и могут быть неточными.";
/** Первая строка приветствия виджета: человек сразу понимает, что говорит не с менеджером. */
export const AI_INTRO = `Я ${AI_LABEL} МТС EnergyTool.`;

// ---------- быстрые ответы ----------

export const MIN_SUGGESTIONS = 2;
export const MAX_SUGGESTIONS = 4;
const MAX_SUGGESTION_CHARS = 60;
/** Значение поля «Задача» паспорта (backend/internal/passport: Tasks) → кнопка ядра (scripts/quick_replies.py: TASK_VALUES). */
export const TASK_BUTTONS: Readonly<Record<string, string>> = {
  "снижение платежа": "Снизить платёж",
  "автоматизация учёта": "Автоматизировать учёт",
  "поиск потерь": "Найти потери",
  "надёжность электроснабжения": "Повысить надёжность электроснабжения",
};

/**
 * Кнопки под последним ответом бота. Ядро присылает 2–4 варианта на уточняющий вопрос; здесь остаются
 * чистые строки без повторов и без задач, которые клиент уже назвал в паспорте. Кнопки показываются, только
 * пока ответ не печатается и после него клиент ещё ничего не написал; поле ввода они не блокируют.
 */
export function visibleSuggestions(
  answer: Pick<AnswerPayload, "suggestions" | "fallback" | "error"> | undefined,
  passport?: Pick<Passport, "fields">,
): string[] {
  if (!answer || answer.fallback || answer.error || !Array.isArray(answer.suggestions)) return [];
  const taken = (passport?.fields.find((f) => f.key === "task")?.value ?? "").toLowerCase();
  const named = new Set(Object.entries(TASK_BUTTONS).filter(([task]) => taken.includes(task)).map(([, label]) => label));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of answer.suggestions) {
    const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
    if (!text || text.length > MAX_SUGGESTION_CHARS || seen.has(text.toLowerCase())) continue;
    if (named.has(text)) continue; // задачу клиент уже назвал — кнопка «Найти потери» после «поиск потерь» лишняя
    seen.add(text.toLowerCase());
    out.push(text);
  }
  const list = out.slice(0, MAX_SUGGESTIONS);
  return list.length >= MIN_SUGGESTIONS ? list : [];
}

/** Кнопки относятся к последнему сообщению ленты — ответу бота. */
export function suggestionsFor(messages: readonly Message[], passport?: Pick<Passport, "fields">): string[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || last.pending || last.error) return [];
  return visibleSuggestions(last.answer, passport);
}

// ---------- первый полезный ответ ----------

/** Полезный ответ: завершён, не запасной, не ошибка и не уточнение ниже порога уверенности. */
export function isUsefulAnswer(m: Message): boolean {
  const a = m.answer;
  return m.role === "assistant" && !m.pending && !m.error && !!a && !a.fallback && !a.error && a.route !== "clarify";
}

/** Предлагать «Связаться с менеджером» в ленте можно только после первого полезного ответа (кнопка в шапке — всегда). */
export const hasUsefulAnswer = (messages: readonly Message[]) => messages.some(isUsefulAnswer);

// ---------- после заявки ----------

export const LEAD_SERVICE_NOTE = "Менеджер свяжется с вами, учитывая удобное время.";
export const LEAD_CONTINUES = "Консультация продолжается: можно задавать вопросы здесь.";
export const LEAD_CHECKLIST_TITLE = "Что подготовить";

export const leadAcceptedTitle = (id: string) => `Ваша заявка №${id} принята`;

/** Все строки блока после заявки: проверяются тестом на отсутствие срока и обещаний по времени звонка. */
export function leadAfterText(id: string): string[] {
  return [leadAcceptedTitle(id), LEAD_SERVICE_NOTE, LEAD_CONTINUES, LEAD_CHECKLIST_TITLE];
}

/**
 * «Что подготовить» под продукт из паспорта — пункты раздела базы «Какие сведения могут понадобиться», которые
 * клиент ещё не назвал. Пусто, если всё названо. Источник и разбор продуктов — buildSummary (T10).
 */
export function leadChecklists(session: Session, kb?: KbLike | null): SummaryChecklist[] {
  return buildSummary(session, kb)
    .checklists.map((c) => ({ ...c, items: c.items.filter((i) => !i.provided) }))
    .filter((c) => c.items.length > 0);
}

// ---------- «Новый диалог» ----------

const CONTACT_KEYS = ["name", "phone", "company"];

/**
 * В диалоге есть начатая, но не отправленная заявка: клиент дал контакты или согласился на передачу, а заявки
 * (Session.lead) ещё нет. Недописанную форму в открытом окне не видно — это граница проверки; там подтверждение
 * не требуется, пока данные не попали в паспорт.
 */
export function hasUnsentLead(session: Pick<Session, "lead" | "passport"> | undefined): boolean {
  if (!session || session.lead) return false;
  const p = session.passport;
  if (!p) return false;
  return p.handoff_agreed || p.fields.some((f) => CONTACT_KEYS.includes(f.key) && !!f.value?.trim());
}

export const NEW_DIALOG_CONFIRM = {
  title: "Начать новый диалог?",
  text: "Заявка в этом диалоге не отправлена. Если начать новый диалог, вернуться к ней можно будет из списка диалогов, но данные придётся проверить заново.",
  stay: "Остаться",
  go: "Новый диалог",
} as const;

// ---------- прокрутка ----------

/** Дистанция до низа ленты, ближе которой человек «внизу». */
export const NEAR_BOTTOM_PX = 160;
/** Отступ над началом ответа при закреплении. */
export const ANSWER_PAD_PX = 12;

export interface ScrollBox {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export const distanceToBottom = (b: ScrollBox) => b.scrollHeight - b.scrollTop - b.clientHeight;

/**
 * Человек отмотал вверх (отпустил «хвост»)? Прокрутка вверх отключает слежение; возврат к низу — включает.
 * Программная прокрутка у нас только вниз, поэтому на ней признак не меняется.
 */
export function nextFollowing(following: boolean, prevTop: number, box: ScrollBox): boolean {
  if (distanceToBottom(box) <= 40) return true;
  if (box.scrollTop < prevTop - 2) return false;
  return following;
}

/**
 * Куда прокрутить ленту, пока ответ печатается или только что закончился. Держим низ, но не дальше начала
 * нового ответа: длинный ответ не уезжает вверх, человек читает его с первой строки и не прыгает в конец.
 * null — оставить как есть (человек прокрутил вверх или двигать нечего). answerTop — позиция начала ответа
 * в координатах содержимого ленты, pad — высота прилипшей шапки + отступ.
 */
export function followTarget(box: ScrollBox, answerTop: number | undefined, following: boolean, pad = ANSWER_PAD_PX): number | null {
  if (!following) return null;
  const bottom = Math.max(0, box.scrollHeight - box.clientHeight);
  const target = answerTop === undefined ? bottom : Math.min(bottom, Math.max(0, answerTop - pad));
  return target > box.scrollTop + 1 ? target : null;
}
