// «Шпаргалка к встрече» (T25): что менеджеру спросить, подготовить и чего не обещать — по заявке.
//
// Собирается детерминированно, без модели, только из того, что уже есть в заявке (паспорт, оценка и её `missing`,
// продукт, тип, удобное время клиента) и из разделов базы знаний. Формулировки из базы приведены дословно —
// meeting-brief.test.ts находит каждую в тексте своего раздела (глобальное ограничение №1 docs/ROADMAP.md).
// Цен, сроков и времени звонка здесь нет и быть не может: база запрещает их обещать.

import { kindInfo } from "./lead-kinds.ts";
import type { LeadKind } from "./lead-kinds.ts";
import type { PassportGroup } from "./types.ts";

/** Раздел базы, откуда взята формулировка; items — дословные фрагменты текста этого раздела. */
export interface KbFacts {
  doc: string;
  section: string;
  items: string[];
}

const REQUESTS = "00-reference/03-calculation-and-requests.md";
const LIMITS = "00-reference/02-product-scope-and-limits.md";

/** «Какие сведения могут понадобиться» — что запросить у клиента, по продуктам (названия подразделов — из базы). */
export const PREPARE: Record<Exclude<PassportGroup, "contacts">, KbFacts> = {
  general: {
    doc: REQUESTS,
    section: "Для первичного понимания задачи",
    items: [
      "тип организации и объекта",
      "присоединённая мощность, если известна",
      "регион",
      "приблизительный объём месячного потребления",
      "существующие приборы учёта и способ сбора показаний",
      "задача клиента: снижение платежа, автоматизация учёта, поиск потерь или повышение надёжности электроснабжения",
    ],
  },
  wholesale: {
    doc: REQUESTS,
    section: "Для анализа затрат и выхода на оптовый рынок",
    items: [
      "присоединённая мощность",
      "месячный объём и профиль потребления",
      "класс напряжения подключения",
      "текущий поставщик электроэнергии",
      "действующая ценовая категория",
      "количество точек поставки и состояние системы учёта",
    ],
  },
  solar: {
    doc: REQUESTS,
    section: "Для солнечной станции",
    items: [
      "регион и характеристики объекта",
      "площадь и тип кровли либо свободной площадки",
      "присоединённая мощность",
      "профиль потребления",
      "цель: снижение платежа или повышение надёжности электроснабжения",
    ],
  },
  platform: {
    doc: REQUESTS,
    section: "Для платформы учёта",
    items: [
      "тип организации",
      "количество и тип приборов",
      "существующая схема сбора данных",
      "задача учёта: по цехам, объектам, арендаторам или абонентам",
    ],
  },
  losses: {
    doc: REQUESTS,
    section: "Для поиска коммерческих потерь",
    items: [
      "обезличенная выгрузка данных учёта",
      "идентификатор канала учёта",
      "даты и значения показаний",
      "суточное потребление с разбивкой на дневное и ночное",
      "адрес установки прибора, серийный номер и категория абонента",
    ],
  },
  recognition: {
    doc: REQUESTS,
    section: "Для распознавания показаний",
    items: ["тип ресурса", "тип и парк приборов", "способ передачи изображений", "объём потока или архива фотографий"],
  },
};

/** Границы продукта — разделы «Область применения продуктов и ограничения». */
export const LIMITS_BY_PRODUCT: Record<Exclude<PassportGroup, "contacts" | "general">, KbFacts> = {
  wholesale: {
    doc: LIMITS,
    section: "Выход на оптовый рынок",
    items: [
      "Ниже 750 кВт присоединённой мощности выход на оптовый рынок невозможен",
      "От 750 кВт, но менее 20 МВт участие возможно через энергосбытовую компанию-посредника; прямым участником предприятие не становится",
      "От 20 МВт возможно прямое участие",
      "В изолированных энергосистемах, указанных в материалах (Камчатка, Магадан, Сахалин, Чукотка), оптовый рынок не функционирует",
    ],
  },
  platform: {
    doc: LIMITS,
    section: "Облачная платформа учёта",
    items: [
      "Платформа ведёт учёт в киловатт-часах и готовит данные для начисления, но не выставляет счета и квитанции",
      "Платформа не передаёт данные напрямую в ресурсоснабжающие организации; клиент может сформировать отчёты и передать их самостоятельно",
      "Энергетическое обследование в рамках продукта учёта не проводится",
      "Нельзя утверждать, что платформа учёта вообще не обрабатывает персональные данные",
    ],
  },
  solar: {
    doc: LIMITS,
    section: "Солнечные электростанции",
    items: [
      "частные жилые дома не входят в целевой сегмент",
      "Сетевая станция отключается вместе с внешней сетью и не обеспечивает автономное питание при её отключении",
      "Экономику проекта не следует строить на продаже излишков электроэнергии в сеть",
    ],
  },
  losses: {
    doc: LIMITS,
    section: "Поиск коммерческих потерь",
    items: [
      "Энергосбытовой компании продукт подходит, если у неё есть сетевая организация на балансе",
      "Результат поиска вероятностный: это список приоритетных проверок, а не установленный факт хищения",
      "Выездная проверка обязательна",
      "Для контроля собственного потребления промышленного предприятия предназначена платформа учёта",
    ],
  },
  recognition: {
    doc: LIMITS,
    section: "Распознавание показаний по фотографии",
    items: [
      "Готовая поддержка описана для электроэнергии и воды",
      "Распознанное показание попадает в коммерческий учёт только после верификации; фотография сама по себе не является основанием для начисления",
    ],
  },
};

/** Общие границы — для любой заявки, в том числе без определённого продукта. */
export const COMMON_LIMITS: KbFacts = {
  doc: LIMITS,
  section: "Общие границы",
  items: [
    "МТС не является энергосбытовой компанией, не продаёт электроэнергию и не выступает поставщиком",
    "Индикативные показатели не являются гарантией",
    "Названия компаний-клиентов, сотрудников, производителей оборудования, поставщиков приборов и подрядчиков в консультации не раскрываются",
  ],
};

/** «Чего не обещать» — запреты базы на встрече и в разговоре по заявке. */
export const NO_PROMISE: KbFacts[] = [
  {
    doc: REQUESTS,
    section: "Обратный звонок",
    items: [
      "Нельзя обещать точное время звонка, имя специалиста или заранее определённое содержание разговора, если эти сведения не подтверждены",
    ],
  },
  {
    doc: LIMITS,
    section: "Общие границы",
    items: ["Точная стоимость, экономический эффект и сроки конкретного проекта определяются после изучения данных объекта"],
  },
  {
    doc: REQUESTS,
    section: "Бесплатная предварительная оценка",
    items: ["Конкретное время подготовки результата заранее не обещается"],
  },
];

/** «Когда требуется специалист» — что решает не менеджер на встрече, а специалист. */
export const SPECIALIST: KbFacts = {
  doc: LIMITS,
  section: "Когда требуется специалист",
  items: [
    "итоговая стоимость или коммерческое предложение",
    "расчёт по данным конкретного предприятия",
    "юридическое заключение по схеме, договору, ответственности или персональным данным на платформе учёта",
    "подтверждение обязательств или сроков от лица компании",
  ],
};

export interface BriefSection {
  id: "known" | "ask" | "prepare" | "limits" | "no-promise";
  title: string;
  items: string[];
  /** Откуда взято: разделы базы знаний; пусто — из заявки. */
  sources: string[];
}

export interface Brief {
  title: string;
  sections: BriefSection[];
}

/** Из заявки берётся только это: ничего нового шпаргалка не придумывает. */
export interface BriefInput {
  code: string;
  company: string;
  name: string;
  kind: LeadKind;
  product: PassportGroup;
  product_label: string;
  grade_label: string;
  callback_label: string;
  score: { missing: string[] };
  passport: { fields?: { label: string; value?: string; group: PassportGroup }[] };
}

const source = (f: KbFacts) => `${f.doc}, «${f.section}»`;

/** Продукт заявки; contacts и неизвестное — общие сведения. */
function productOf(input: BriefInput): Exclude<PassportGroup, "contacts" | "general"> | null {
  return input.product in LIMITS_BY_PRODUCT ? (input.product as Exclude<PassportGroup, "contacts" | "general">) : null;
}

export function buildBrief(input: BriefInput): Brief {
  const product = productOf(input);
  const sections: BriefSection[] = [];

  const known = [`Продукт: ${product ? input.product_label : "пока не определён"}`, `Оценка заявки: ${input.grade_label || "нет"}`];
  const kind = kindInfo(input.kind);
  known.push(`Тип заявки: ${kind.label} — ${kind.hint}`);
  known.push(
    input.callback_label
      ? `Удобное время по словам клиента: ${input.callback_label} (пожелание, не договорённость)`
      : "Удобное время клиент не указал",
  );
  for (const f of input.passport.fields ?? []) {
    if (f.value && f.group !== "contacts") known.push(`${f.label}: ${f.value}`);
  }
  sections.push({ id: "known", title: "Что уже известно", items: known, sources: [] });

  sections.push({
    id: "ask",
    title: "Что спросить",
    items:
      input.score.missing.length > 0
        ? input.score.missing
        : ["Чек-лист продукта заполнен — уточните детали задачи и состав данных, которые клиент готов показать"],
    sources: [],
  });

  const prepare = [PREPARE.general, ...(product ? [PREPARE[product]] : [])];
  sections.push({
    id: "prepare",
    title: "Что подготовить и запросить у клиента",
    items: prepare.flatMap((p) => p.items),
    sources: prepare.map(source),
  });

  const limits = [...(product ? [LIMITS_BY_PRODUCT[product]] : []), COMMON_LIMITS];
  sections.push({
    id: "limits",
    title: product ? `Границы продукта «${input.product_label}»` : "Границы продуктов",
    items: limits.flatMap((l) => l.items),
    sources: limits.map(source),
  });

  const noPromise = [...NO_PROMISE, SPECIALIST];
  sections.push({
    id: "no-promise",
    title: "Чего не обещать",
    items: [...NO_PROMISE.flatMap((n) => n.items), `Решает специалист, а не встреча: ${SPECIALIST.items.join("; ")}`],
    sources: noPromise.map(source),
  });

  return { title: `Шпаргалка к встрече · заявка №${input.code}${input.company ? ` · ${input.company}` : ""}`, sections };
}

/** Простой текст — для копирования в заметки. */
export function briefText(brief: Brief): string {
  const out = [brief.title, ""];
  for (const s of brief.sections) {
    out.push(s.title.toUpperCase());
    for (const item of s.items) out.push(`- ${item}`);
    if (s.sources.length > 0) out.push(`  (база знаний: ${s.sources.join("; ")})`);
    out.push("");
  }
  return out.join("\n").trim();
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Страница для печати: своё окно без каркаса стенда, чтобы лист не обрезался прокруткой. */
export function briefHtml(brief: Brief): string {
  const body = brief.sections
    .map(
      (s) =>
        `<section><h2>${escapeHtml(s.title)}</h2><ul>${s.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>` +
        (s.sources.length > 0 ? `<p class="src">База знаний: ${escapeHtml(s.sources.join("; "))}</p>` : "") +
        "</section>",
    )
    .join("");
  return (
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(brief.title)}</title><style>` +
    "body{font:14px/1.5 system-ui,sans-serif;color:#1d2023;max-width:760px;margin:24px auto;padding:0 16px}" +
    "h1{font-size:20px}h2{font-size:15px;margin:20px 0 6px}ul{margin:0;padding-left:20px}li{margin:3px 0}" +
    ".src{font-size:12px;color:#626c77;margin:6px 0 0}section{break-inside:avoid}" +
    `</style></head><body><h1>${escapeHtml(brief.title)}</h1>${body}</body></html>`
  );
}
