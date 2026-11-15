// Типы заявки (T17) — не только «перезвоните». Каждый описан в базе знаний; какой тип годится какому продукту,
// решает и сервер (backend/internal/lead/kind.go, KindsFor) — здесь та же таблица, lead-kinds.test.ts сверяет их.

import type { PassportGroup, Session } from "./types";

export type LeadKind = "callback" | "assessment" | "demo" | "pilot";

export interface LeadKindInfo {
  kind: LeadKind;
  label: string;
  /** Пояснение под названием — по формулировкам базы. */
  hint: string;
  /** Что добавить к «Заявка сохранена.» после отправки; пусто — нечего. */
  note: string;
  /** Для каких продуктов из паспорта; null — для всех. */
  products: PassportGroup[] | null;
  /** Основание в базе: документ, раздел и цитаты, которые тест находит в тексте раздела. */
  kb: { doc: string; section: string; quotes: string[] };
}

export const LEAD_KINDS: LeadKindInfo[] = [
  {
    kind: "callback",
    label: "Обратный звонок",
    hint: "Удобнее устно описать объект или разобрать сложную схему.",
    note: "",
    products: null,
    kb: {
      doc: "00-reference/03-calculation-and-requests.md",
      section: "Обратный звонок",
      quotes: ["если клиенту удобнее устно описать объект или требуется разобрать сложную схему"],
    },
  },
  {
    kind: "assessment",
    label: "Бесплатная предварительная оценка",
    hint: "Оценка эффекта по данным объекта. Не является коммерческим предложением и не обязывает начинать проект.",
    note: "Предварительная оценка не является коммерческим предложением, срок её подготовки заранее не обещаем.",
    products: null,
    kb: {
      doc: "00-reference/03-calculation-and-requests.md",
      section: "Бесплатная предварительная оценка",
      quotes: [
        "бесплатная предварительная оценка",
        "не является коммерческим предложением",
        "не обязывает клиента начинать проект",
        "Конкретное время подготовки результата заранее не обещается",
      ],
    },
  },
  {
    kind: "demo",
    label: "Демо-кабинет",
    hint: "Демонстрационный доступ к платформе учёта по запросу.",
    note: "Демо-кабинет предоставляется по запросу.",
    products: ["platform"],
    kb: {
      doc: "20-products/22-askue.md",
      section: "Как посмотреть до покупки",
      quotes: ["Демо-кабинет предоставляется по запросу"],
    },
  },
  {
    kind: "pilot",
    label: "Пилот: один прибор из пяти",
    hint: "Перевести на платформу один прибор из пяти, посмотреть, как это работает, а затем остальные.",
    note: "",
    products: ["platform"],
    kb: {
      doc: "20-products/22-askue.md",
      section: "Как посмотреть до покупки",
      quotes: ["один прибор из пяти", "смотрит, как это работает, и после этого переводит остальные"],
    },
  },
];

/** Типы, которые годятся для продуктов, обсуждавшихся в разговоре (product_candidates паспорта). */
export function kindsFor(products: PassportGroup[]): LeadKindInfo[] {
  return LEAD_KINDS.filter((k) => !k.products || k.products.some((p) => products.includes(p)));
}

export const kindInfo = (kind: LeadKind) => LEAD_KINDS.find((k) => k.kind === kind) ?? LEAD_KINDS[0];

/**
 * Предвыбор по словам клиента («покажите демо», «сначала попробовать на одном счётчике», «посчитайте») — только
 * среди подходящих типов. Клиент видит выбор и может его поменять.
 */
export function guessKind(clientText: string, allowed: LeadKindInfo[]): LeadKind {
  const t = clientText.toLowerCase();
  const ok = (k: LeadKind) => allowed.some((a) => a.kind === k);
  if (ok("demo") && /демо|демонстрац/.test(t)) return "demo";
  if (ok("pilot") && /пилот|попробовать|для начала на одн/.test(t)) return "pilot";
  if (ok("assessment") && /оценк|расч[её]т|рассчита|посчита/.test(t)) return "assessment";
  return "callback";
}

/** Типы для разговора и предвыбор по репликам клиента. */
export function sessionKinds(session: Session): { kinds: LeadKindInfo[]; guess: LeadKind } {
  const kinds = kindsFor((session.passport?.product_candidates ?? []).map((c) => c.product));
  const said = session.messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
  return { kinds, guess: guessKind(said, kinds) };
}
