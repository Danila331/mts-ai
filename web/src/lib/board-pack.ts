/**
 * «Пакет для правления» (T22): вариант «Итогов консультации» (T10) для СНТ, управляющей компании, ТСЖ — документ,
 * который председатель может показать правлению. Собирается в браузере из сессии в localStorage, на сервер
 * ничего не уходит.
 *
 * Чистый модуль: только type-импорты и чистые функции T10/T26, без React и сети — его гоняет
 * `node --experimental-strip-types --test` (`board-pack.test.ts`).
 *
 * Правило документа — никаких денег и обещаний и никакого нового текста о продуктах. Содержательные строки
 * из трёх мест:
 *   - реплики клиента и значения паспорта задачи — как клиент их сообщил (контакты не попадают);
 *   - цитаты базы знаний ({@link BOARD_QUOTES}, чек-листы T10, оговорки T10) — дословные фрагменты разделов
 *     с ссылкой на раздел; каждую сверяет с текстом базы тест;
 *   - плашки «Честно: не подойдёт» (T26) из ответов сессии — `reason` и `alternative.text` сервер берёт из базы
 *     и сам сверяет с разделом.
 * Ни цен, ни окупаемости, ни экономии, ни сроков: из всех ответов бота в документ не идёт ни одного факта о
 * продуктах — в них бывают числа, а числа в этом документе читает правление. Формулировка клиента «отключать
 * неплательщиков» в документ не попадает: продукт описан словами базы — «дистанционное управление нагрузкой».
 */
import {
  CHECKLISTS,
  CHECKLIST_NOTE,
  DISCLAIMER,
  DISCLAIMER_SECTION,
  KB_DOC,
  type KbLike,
  type SummaryChecklist,
  buildSummary,
  kbSectionHref,
  squash,
} from "./consultation-summary.ts";
import { HONEST_NO_TITLE, honestNoItems, sectionHref, sectionLabel } from "./honest-no.ts";
import type { Session } from "./types.ts";

export { HONEST_NO_TITLE };

/** Роль сессии (T15), для которой пакет показывается сразу. */
export const BOARD_ROLE = "housing";

export type SummaryFormat = "summary" | "board";

/** Какой формат показать в окне итогов сначала: для роли СНТ, УК, ТСЖ — пакет для правления. */
export function defaultFormat(session: Pick<Session, "role"> | undefined): SummaryFormat {
  return session?.role === BOARD_ROLE ? "board" : "summary";
}

// ---------- цитаты базы ----------

export interface BoardQuote {
  /** Фрагмент раздела дословно (пробелы схлопнуты, разметка `**` и ссылки `[…](…)` убраны). */
  text: string;
  /** Документ базы и последний заголовок раздела: по ним строится ссылка `/kb?chunk=`. */
  doc: string;
  section: string;
  /** Продукт или тема, к которым относится цитата, — подпись над ней. */
  label?: string;
}

const PORTFOLIO = "20-products/20-portfolio.md";
const ASKUE = "20-products/22-askue.md";
const READING = "20-products/25-meter-reading.md";
const SCOPE = "00-reference/02-product-scope-and-limits.md";

/** Что база говорит о продуктах для УК, ТСЖ, СНТ, товарищества. */
export const ORG_QUOTES: readonly BoardQuote[] = [
  {
    label: "Облачная платформа учёта",
    text: "учёт по абонентам и местам общего пользования, дистанционное управление нагрузкой, корректное распределение расхода",
    doc: PORTFOLIO,
    section: "Управляющая компания, ТСЖ, СНТ, товарищество",
  },
  {
    label: "Облачная платформа учёта",
    text: "Для товариществ - корректное распределение расхода мест общего пользования и дистанционное управление нагрузкой абонентов.",
    doc: ASKUE,
    section: "Что даёт клиенту",
  },
  {
    label: "Распознавание показаний по фото",
    text: "приём показаний от жителей без обходов и без ручного ввода",
    doc: PORTFOLIO,
    section: "Управляющая компания, ТСЖ, СНТ, товарищество",
  },
  {
    label: "Платформа учёта плюс распознавание показаний по фото",
    text: "Платформа снимает данные с подключённых приборов, распознавание закрывает парк, который к системе не подключён",
    doc: PORTFOLIO,
    section: "Как продукты связаны между собой",
  },
];

/** Чего продукт не делает — дословно из базы. */
export const LIMIT_QUOTES: readonly BoardQuote[] = [
  {
    label: "Облачная платформа учёта",
    text: "Не выставляем счета и квитанции. Платформа ведёт учёт в киловатт-часах и готовит данные для начисления, но расчётами с абонентами в рублях не занимается.",
    doc: ASKUE,
    section: "Что мы не делаем",
  },
  {
    label: "Облачная платформа учёта",
    text: "Не передаём данные напрямую в ресурсоснабжающие организации. Клиент может сформировать отчёты и передать их самостоятельно.",
    doc: ASKUE,
    section: "Что мы не делаем",
  },
  {
    label: "Облачная платформа учёта",
    text: "Не проводим энергетическое обследование в рамках продукта учёта.",
    doc: ASKUE,
    section: "Что мы не делаем",
  },
  {
    label: "Распознавание показаний по фото",
    text: "Распознанное показание является дополнительным подтверждением и предназначено для технических нужд. В коммерческий учёт, то есть в расчёты с абонентом, оно попадает только после верификации.",
    doc: READING,
    section: "Важное ограничение по применению",
  },
  {
    label: "Распознавание показаний по фото",
    text: "Фотография сама по себе не становится основанием для начисления.",
    doc: READING,
    section: "Важное ограничение по применению",
  },
];

/** Оговорки базы о данных — дословно; оговорки об оценке — {@link DISCLAIMER} из T10. */
export const CAVEAT_QUOTES: readonly BoardQuote[] = [
  {
    label: "Облачная платформа учёта",
    text: "Вопросы обработки персональных данных на платформе учёта зависят от договорной модели.",
    doc: SCOPE,
    section: "Облачная платформа учёта",
  },
  {
    label: "Распознавание показаний по фото",
    text: "Персональные данные абонентов на стороне МТС не хранятся и не обрабатываются.",
    doc: READING,
    section: "Персональные данные",
  },
];

/** Продукты, которые база называет для этой организации, и чек-листы «что подготовить» к ним. */
export const BOARD_CHECKLISTS = ["platform", "recognition"] as const;

// ---------- тексты документа ----------

export const BOARD_TITLE = "Пакет для правления";
export const BOARD_SUBTITLE = "СНТ, управляющая компания, ТСЖ";
export const BOARD_INTRO =
  "Собрано из разговора с ИИ-консультантом МТС EnergyTool: вопросы к консультанту и цитаты базы знаний. Расчёта и коммерческого предложения здесь нет.";
export const BOARD_LIMITS_TITLE = "Чего продукт не делает";
export const BOARD_LIMITS_NOTE = "Цитаты базы знаний дословно; у каждой указан раздел.";

// ---------- результат ----------

export interface BoardLink {
  text: string;
  href: string;
  /** Подпись источника: «Документ › раздел». */
  source: string;
}

export interface BoardHonestNo {
  rule: string;
  product: string;
  /** Дословный текст раздела базы (его сверил сервер). */
  reason: string;
  link: BoardLink | null;
  alternative: { text: string; link: BoardLink | null } | null;
}

export interface BoardPack {
  title: string;
  subtitle: string;
  intro: string;
  updatedAt: number;
  leadId?: string;
  /** Вопросы клиента по порядку; контакты скрыты. */
  questions: string[];
  moreQuestions: number;
  /** Что клиент сообщил о задаче — поля паспорта без контактов. */
  passport: { key: string; label: string; value: string }[];
  /** Названия продуктов, о которых шла речь в разговоре. */
  discussed: string[];
  org: BoardQuoteView[];
  limits: BoardQuoteView[];
  honestNo: BoardHonestNo[];
  checklistNote: string;
  checklists: SummaryChecklist[];
  caveats: BoardQuoteView[];
  /**
   * Оговорки об оценке — дословно из T10, но без первой фразы раздела («…оценка экономического эффекта…»):
   * в документе для правления об экономике не говорим. heading — заголовок раздела базы.
   */
  disclaimer: { heading: string; lead: string; points: readonly string[]; timing: string; href: string };
}

export interface BoardQuoteView extends BoardQuote {
  href: string;
}

const view = (q: BoardQuote, kb?: KbLike | null): BoardQuoteView => ({ ...q, href: kbSectionHref(kb, q.doc, q.section) });

/** Плашки «Честно: не подойдёт» (T26) из всех ответов сессии, без повторов правил. */
function collectHonestNo(session: Session): BoardHonestNo[] {
  const out: BoardHonestNo[] = [];
  const seen = new Set<string>();
  for (const m of session.messages) {
    if (m.role !== "assistant" || m.pending || m.error) continue;
    for (const item of honestNoItems(m.answer)) {
      if (seen.has(item.rule)) continue;
      seen.add(item.rule);
      out.push({
        rule: item.rule,
        product: item.product,
        reason: item.reason,
        link: item.section ? { text: sectionLabel(item.section), href: sectionHref(item.section), source: sectionLabel(item.section) } : null,
        alternative: item.alternative
          ? {
              text: item.alternative.text,
              link: item.alternative.section
                ? {
                    text: sectionLabel(item.alternative.section),
                    href: sectionHref(item.alternative.section),
                    source: sectionLabel(item.alternative.section),
                  }
                : null,
            }
          : null,
      });
    }
  }
  return out;
}

export function buildBoardPack(session: Session, kb?: KbLike | null): BoardPack {
  const base = buildSummary(session, kb);
  const values = new Map(
    (session.passport?.fields ?? []).filter((f) => f.value?.trim()).map((f) => [f.key, f.value!.trim()] as const),
  );
  const checklists: SummaryChecklist[] = BOARD_CHECKLISTS.map((key) => {
    const src = CHECKLISTS[key];
    return {
      key,
      heading: src.heading,
      href: kbSectionHref(kb, KB_DOC, src.heading),
      items: src.items.map((i) => ({
        text: i.text,
        provided: i.fields.length > 0 && i.fields.every((f) => values.has(f)),
      })),
      notes: [...(src.notes ?? [])],
    };
  });
  return {
    title: BOARD_TITLE,
    subtitle: BOARD_SUBTITLE,
    intro: BOARD_INTRO,
    updatedAt: base.updatedAt,
    leadId: base.leadId,
    questions: base.questions,
    moreQuestions: base.moreQuestions,
    passport: base.passport,
    discussed: base.products.map((p) => p.label),
    org: ORG_QUOTES.map((q) => view(q, kb)),
    limits: LIMIT_QUOTES.map((q) => view(q, kb)),
    honestNo: collectHonestNo(session),
    checklistNote: CHECKLIST_NOTE,
    checklists,
    caveats: CAVEAT_QUOTES.map((q) => view(q, kb)),
    disclaimer: {
      heading: DISCLAIMER_SECTION,
      lead: DISCLAIMER.lead,
      points: DISCLAIMER.points,
      timing: DISCLAIMER.timing,
      href: kbSectionHref(kb, KB_DOC, DISCLAIMER_SECTION),
    },
  };
}

/** Имя файла при «Сохранить как PDF»: браузер берёт его из заголовка документа. */
export function boardFileTitle(pack: Pick<BoardPack, "updatedAt">): string {
  const d = new Date(pack.updatedAt);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `Пакет для правления EnergyTool ${dd}.${mm}.${d.getFullYear()}`;
}

/** Все тексты документа, которые написаны не клиентом: для проверки «нет денег и обещаний». */
export function boardOwnTexts(pack: BoardPack): string[] {
  const quotes = [...pack.org, ...pack.limits, ...pack.caveats].flatMap((q) => [q.text, q.label ?? ""]);
  const honest = pack.honestNo.flatMap((h) => [h.reason, h.alternative?.text ?? ""]);
  const lists = pack.checklists.flatMap((c) => [c.heading, ...c.items.map((i) => i.text), ...c.notes]);
  return [
    pack.title,
    pack.subtitle,
    pack.intro,
    BOARD_LIMITS_TITLE,
    BOARD_LIMITS_NOTE,
    pack.checklistNote,
    pack.disclaimer.heading,
    pack.disclaimer.lead,
    ...pack.disclaimer.points,
    pack.disclaimer.timing,
    ...pack.discussed,
    ...quotes,
    ...honest,
    ...lists,
  ].map((t) => squash(t));
}
