/**
 * «Честные нет» (T26): что показать в плашке под ответом.
 *
 * Чистый модуль без React — его напрямую гоняет `node --experimental-strip-types --test`. Правила и тексты
 * живут на сервере ядра (scripts/honest_no.py) и сверяются с базой там же; здесь только отбор того, что
 * можно показать: без раздела базы плашки нет — «нет» без источника клиенту не говорим.
 */
import type { AnswerPayload, HonestNo, HonestNoSection } from "./types.ts";

export const HONEST_NO_TITLE = "Честно: не подойдёт";
export const HONEST_NO_LEAD = "Вам это, скорее всего, не подойдёт, потому что";
/** Вторая причина про тот же продукт: заголовок не повторяем (две одинаковые плашки выглядели как дубль). */
export const HONEST_NO_ALSO = "Ещё одна причина";

/** Та же причина для того же продукта, что и предыдущий пункт: показывать без повторного заголовка. */
export const sameProductAsPrevious = (items: readonly Pick<HonestNo, "product">[], i: number) =>
  i > 0 && items[i - 1].product === items[i].product;
/** Больше двух причин под одним ответом — уже не плашка, а лекция. */
export const HONEST_NO_MAX = 2;

function isSection(s: unknown): s is HonestNoSection {
  return !!s && typeof s === "object" && typeof (s as HonestNoSection).chunk_id === "string" && !!(s as HonestNoSection).chunk_id;
}

/** Пункты плашки: только с разделом базы, без повторов правила, не больше {@link HONEST_NO_MAX}. */
export function honestNoItems(answer: Pick<AnswerPayload, "honest_no"> | null | undefined): HonestNo[] {
  const out: HonestNo[] = [];
  const seen = new Set<string>();
  for (const item of answer?.honest_no ?? []) {
    if (!item || typeof item.reason !== "string" || !item.reason.trim() || !isSection(item.section)) continue;
    if (seen.has(item.rule)) continue;
    seen.add(item.rule);
    const alternative =
      item.alternative && typeof item.alternative.text === "string" && item.alternative.text.trim()
        ? { text: item.alternative.text, section: isSection(item.alternative.section) ? item.alternative.section : null }
        : null;
    out.push({ ...item, product: item.product || "Продукт", fact: item.fact || "", alternative });
    if (out.length >= HONEST_NO_MAX) break;
  }
  return out;
}

/** Ссылка на раздел базы — та же, что у источников ответа. */
export function sectionHref(section: HonestNoSection): string {
  return `/kb?chunk=${encodeURIComponent(section.chunk_id)}`;
}

/** Подпись раздела: «Документ › раздел» по последнему заголовку цепочки. */
export function sectionLabel(section: HonestNoSection): string {
  const last = section.path.split(" > ").pop() || section.path;
  return section.title && last !== section.title ? `${section.title} › ${last}` : last;
}
