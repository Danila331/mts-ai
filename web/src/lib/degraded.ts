/**
 * Деградация при сбоях (T30): что показать, когда модель или ядро недоступны.
 *
 * Чистый модуль без React — его гоняет `node --experimental-strip-types --test`. Тексты баннера — без
 * технических деталей: клиенту не нужны ни коды, ни названия служб.
 */
import type { AnswerPayload, DegradedSection, Health } from "./types.ts";

export const DEGRADED_TITLE = "Вот что есть в материалах";
export const DEGRADED_MAX = 3;

function isSection(s: unknown): s is DegradedSection {
  const x = s as DegradedSection | null;
  return !!x && typeof x === "object" && typeof x.chunk_id === "string" && !!x.chunk_id && typeof x.excerpt === "string" && !!x.excerpt.trim();
}

/** Разделы блока «вот что есть в материалах»: только с id и текстом, без повторов, не больше {@link DEGRADED_MAX}. */
export function degradedSections(answer: Pick<AnswerPayload, "degraded"> | null | undefined): DegradedSection[] {
  const out: DegradedSection[] = [];
  const seen = new Set<string>();
  for (const s of answer?.degraded?.sections ?? []) {
    if (!isSection(s) || seen.has(s.chunk_id)) continue;
    seen.add(s.chunk_id);
    out.push({ ...s, title: s.title || s.doc, path: s.path || "" });
    if (out.length >= DEGRADED_MAX) break;
  }
  return out;
}

/** Ссылка на раздел базы — та же, что у источников ответа. */
export function degradedHref(section: Pick<DegradedSection, "chunk_id">): string {
  return `/kb?chunk=${encodeURIComponent(section.chunk_id)}`;
}

export interface Banner {
  tone: "warning" | "danger";
  title: string;
  text: string;
}

/**
 * Баннер статуса. health — ответ /api/health, null — ещё не знаем; unreachable — API или ядро не ответили;
 * answerDegraded — последний ответ уже пришёл без модели (модель могла упасть между опросами состояния).
 */
export function statusBanner(input: { health: Health | null; unreachable: boolean; answerDegraded?: boolean }): Banner | null {
  if (input.unreachable) {
    return {
      tone: "danger",
      title: "Консультант перезапускается",
      text: "Ответы появятся через минуту. Заявку можно оставить уже сейчас — менеджер её получит.",
    };
  }
  if (input.answerDegraded || (input.health && !input.health.llm)) {
    return {
      tone: "warning",
      title: "Отвечаю в упрощённом режиме",
      text: "Сейчас показываю подходящие разделы материалов. Заявку менеджеру можно оставить как обычно.",
    };
  }
  return null;
}
