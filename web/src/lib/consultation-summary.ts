/**
 * «Итоги консультации» для клиента (T10): документ, который энергетик может сохранить в PDF и переслать
 * директору. Собирается в браузере из сессии в localStorage — на сервер ничего не уходит.
 *
 * Чистый модуль: только type-импорты (их стирает `node --experimental-strip-types`), без React и сети.
 *
 * Правило документа — никакого нового текста о продуктах. Каждая содержательная строка взята из одного
 * из трёх мест, и это проверяет `consultation-summary.test.ts`:
 *   - реплики клиента и значения паспорта задачи — как клиент их сообщил (контакты не попадают);
 *   - факты о продуктах — дословные предложения ответов бота, у которых есть опора в базе, со ссылками
 *     на эти разделы; предложения с числами без опоры и вопросы клиенту отбрасываются;
 *   - чек-лист «что подготовить» и оговорки — цитаты раздела базы {@link KB_DOC}.
 * Резюме заявки для менеджера (`Session.lead.summary`) написано моделью — в документ не идёт, только номер.
 */
import type { AnswerPayload, Message, Passport, PassportGroup, Session } from "./types.ts";

// ---------- опора на базу знаний ----------

export const KB_DOC = "00-reference/03-calculation-and-requests.md";
/** Раздел базы, из подразделов которого собран чек-лист. */
export const CHECKLIST_SECTION = "Какие сведения могут понадобиться";
/** Первая строка этого раздела — показывается над чек-листом дословно. */
export const CHECKLIST_NOTE = "Состав данных зависит от продукта и задачи.";

export type ProductKey = Exclude<PassportGroup, "general" | "contacts">;
export type ChecklistKey = ProductKey | "general";

/** Продукты и их документы базы — тот же список, что у сервера (backend/internal/passport: Products). */
export const PRODUCTS: readonly { key: ProductKey; label: string; doc: string }[] = [
  { key: "wholesale", label: "Оптовый рынок и анализ затрат", doc: "20-products/21-orem.md" },
  { key: "platform", label: "Платформа учёта", doc: "20-products/22-askue.md" },
  { key: "solar", label: "Солнечная станция", doc: "20-products/23-solar.md" },
  { key: "losses", label: "Поиск коммерческих потерь", doc: "20-products/24-losses.md" },
  { key: "recognition", label: "Распознавание показаний", doc: "20-products/25-meter-reading.md" },
];

export interface ChecklistSource {
  /** Подраздел «### …» раздела {@link CHECKLIST_SECTION}. */
  heading: string;
  /** Пункты списка дословно, без «-» и завершающей «;»/«.». fields — поля паспорта, которыми пункт закрыт. */
  items: readonly { text: string; fields: readonly string[] }[];
  /** Абзацы после списка — дословно. */
  notes?: readonly string[];
}

/** Чек-листы базы по продуктам. Каждую строку сверяет с текстом базы тест — поменяется база, упадёт тест. */
export const CHECKLISTS: Record<ChecklistKey, ChecklistSource> = {
  general: {
    heading: "Для первичного понимания задачи",
    items: [
      { text: "тип организации и объекта", fields: ["org_type", "object_type"] },
      { text: "присоединённая мощность, если известна", fields: ["connected_power"] },
      { text: "регион", fields: ["region"] },
      { text: "приблизительный объём месячного потребления", fields: ["monthly_consumption"] },
      { text: "существующие приборы учёта и способ сбора показаний", fields: ["metering"] },
      {
        text: "задача клиента: снижение платежа, автоматизация учёта, поиск потерь или повышение надёжности электроснабжения",
        fields: ["task"],
      },
    ],
  },
  wholesale: {
    heading: "Для анализа затрат и выхода на оптовый рынок",
    items: [
      { text: "присоединённая мощность", fields: ["connected_power"] },
      { text: "месячный объём и профиль потребления", fields: ["monthly_consumption", "consumption_profile"] },
      { text: "класс напряжения подключения", fields: ["voltage_class"] },
      { text: "текущий поставщик электроэнергии", fields: ["supplier"] },
      { text: "действующая ценовая категория", fields: ["price_category"] },
      { text: "количество точек поставки и состояние системы учёта", fields: ["supply_points"] },
    ],
  },
  solar: {
    heading: "Для солнечной станции",
    items: [
      { text: "регион и характеристики объекта", fields: ["region", "object_type"] },
      { text: "площадь и тип кровли либо свободной площадки", fields: ["site_area"] },
      { text: "присоединённая мощность", fields: ["connected_power"] },
      { text: "профиль потребления", fields: ["consumption_profile"] },
      { text: "цель: снижение платежа или повышение надёжности электроснабжения", fields: ["task"] },
    ],
  },
  platform: {
    heading: "Для платформы учёта",
    items: [
      { text: "тип организации", fields: ["org_type"] },
      { text: "количество и тип приборов", fields: ["meters"] },
      { text: "существующая схема сбора данных", fields: ["collection_scheme"] },
      { text: "задача учёта: по цехам, объектам, арендаторам или абонентам", fields: ["metering_goal"] },
    ],
  },
  losses: {
    heading: "Для поиска коммерческих потерь",
    items: [
      { text: "обезличенная выгрузка данных учёта", fields: ["metering_data"] },
      { text: "идентификатор канала учёта", fields: [] },
      { text: "даты и значения показаний", fields: [] },
      { text: "суточное потребление с разбивкой на дневное и ночное", fields: [] },
      { text: "адрес установки прибора, серийный номер и категория абонента", fields: [] },
    ],
    notes: [
      "Минимально достаточно суточных данных с разбивкой на день и ночь.",
      "Часовые или получасовые интервалы желательны.",
      "В материалах указана глубина архива не менее одного года.",
    ],
  },
  recognition: {
    heading: "Для распознавания показаний",
    items: [
      { text: "тип ресурса", fields: ["resource_type"] },
      { text: "тип и парк приборов", fields: ["meter_fleet"] },
      { text: "способ передачи изображений", fields: ["image_channel"] },
      { text: "объём потока или архива фотографий", fields: ["photo_volume"] },
      { text: "состав интеграции определяется проектом", fields: [] },
    ],
  },
};

/** Раздел базы с оговорками о предварительной оценке. */
export const DISCLAIMER_SECTION = "Бесплатная предварительная оценка";

/** Оговорки — дословно из {@link DISCLAIMER_SECTION}: оценка не коммерческое предложение, срок не обещается. */
export const DISCLAIMER = {
  intro: "Для продуктов EnergyTool доступна бесплатная предварительная оценка экономического эффекта по данным объекта.",
  lead: "Расчёт:",
  points: ["не является коммерческим предложением", "не обязывает клиента начинать проект"],
  timing: "Конкретное время подготовки результата заранее не обещается.",
} as const;

// ---------- пороги отбора фактов ----------

/** Сколько фактов показать у продукта (ROADMAP T10: «1–2 факта дословно из ответов бота»). */
export const MAX_FACTS_PER_PRODUCT = 2;
/** Минимальная доля слов предложения, найденная в разделе базы (`attribute` в scripts/core_api.py). */
export const MIN_OVERLAP = 0.5;
/**
 * С какой опоры предложение относит разговор к продукту (продукты в итогах и чек-листы «Что подготовить»). Тот же
 * порог, что в паспорте на сервере (backend/internal/chat: MinProductOverlap). Подобран на ручном прогоне с живой
 * моделью: верная опора на платформу учёта — 0,60–0,86, случайное совпадение с распознаванием по фото — 0,30–0,50.
 */
export const PRODUCT_MIN_OVERLAP = 0.6;
const MIN_FACT_CHARS = 20;
const MAX_FACT_CHARS = 400;
const MAX_QUESTIONS = 12;

// ---------- результат ----------

export interface SummarySource {
  chunkId: string;
  doc: string;
  /** Название документа базы, если известно (из /api/kb), иначе — путь файла. */
  docTitle: string;
  /** Последний заголовок раздела. */
  section: string;
  href: string;
}

export interface SummaryFact {
  /** Предложение ответа бота как есть (только пробелы схлопнуты). */
  text: string;
  messageId: string;
  sources: SummarySource[];
}

export interface SummaryProduct {
  key: ProductKey;
  label: string;
  /** Название документа базы о продукте. */
  docTitle: string;
  facts: SummaryFact[];
}

export interface SummaryChecklistItem {
  text: string;
  /** Клиент уже сообщил это в разговоре — есть в паспорте задачи. */
  provided: boolean;
}

export interface SummaryChecklist {
  key: ChecklistKey;
  heading: string;
  href: string;
  items: SummaryChecklistItem[];
  notes: string[];
}

export interface ConsultationSummary {
  title: string;
  startedAt: number;
  updatedAt: number;
  /** Вопросы клиента по порядку; телефоны, e-mail и имя из паспорта скрыты. */
  questions: string[];
  /** Сколько вопросов не поместилось в {@link MAX_QUESTIONS}. */
  moreQuestions: number;
  /** Что клиент сообщил о задаче — поля паспорта без контактов. */
  passport: { key: string; label: string; value: string }[];
  products: SummaryProduct[];
  checklistNote: string;
  checklists: SummaryChecklist[];
  /** Номер заявки, если клиент её оставил. Резюме для менеджера в документ не идёт. */
  leadId?: string;
  disclaimer: typeof DISCLAIMER & { href: string };
}

/** Минимум из GET /api/kb: названия документов и id разделов для ссылок. */
export interface KbLike {
  docs: readonly { doc: string; title: string; chunks: readonly { id: string; path: string }[] }[];
}

// ---------- помощники ----------

/** Пробелы и переводы строк — в один пробел. */
export const squash = (s: string) => s.replace(/\s+/g, " ").trim();

const lastHeading = (path: string) => path.split(" > ").pop()?.trim() ?? "";

const fileName = (doc: string) => doc.split("/").pop() ?? doc;

function findDoc(kb: KbLike | null | undefined, doc: string) {
  return kb?.docs.find((d) => d.doc === doc || fileName(d.doc) === fileName(doc));
}

/** Название документа: из /api/kb; пока база не загрузилась — название продукта или имя файла. */
function docTitle(kb: KbLike | null | undefined, doc: string, title?: string) {
  return (
    title ||
    findDoc(kb, doc)?.title ||
    PRODUCTS.find((p) => fileName(p.doc) === fileName(doc))?.label ||
    fileName(doc)
  );
}

/** Ссылка на подраздел базы: id раздела зависит от текста, поэтому ищем его в /api/kb, без базы — на документ. */
export function kbSectionHref(kb: KbLike | null | undefined, doc: string, heading: string): string {
  const d = findDoc(kb, doc);
  const chunk = d?.chunks.find((c) => lastHeading(c.path) === heading);
  if (chunk) return `/kb?chunk=${encodeURIComponent(chunk.id)}`;
  return `/kb?doc=${encodeURIComponent(d?.doc ?? doc)}`;
}

const PHONE = /(?:\+7|\b8)[\s\-()]*\d(?:[\s\-()]*\d){9}\b/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Документ уходит дальше по почте: телефон, e-mail и имя из паспорта в репликах клиента скрываем. */
export function maskContacts(text: string, passport?: Passport): string {
  let out = text.replace(PHONE, "[телефон скрыт]").replace(EMAIL, "[e-mail скрыт]");
  const name = passport?.fields.find((f) => f.key === "name")?.value?.trim();
  if (name && name.length >= 3) out = out.split(name).join("[имя скрыто]");
  return out;
}

/** Ответ годится как источник фактов: завершён, не запасной, не уточняющий вопрос. */
function usableAnswer(m: Message): AnswerPayload | undefined {
  const a = m.answer;
  if (m.role !== "assistant" || m.pending || m.error || !a) return;
  if (a.fallback || a.error || a.route === "clarify") return;
  return a;
}

/** Есть хотя бы один завершённый ответ бота — кнопку «Итоги консультации» можно показывать. */
export function canSummarize(session: Session | undefined): boolean {
  return !!session?.messages.some((m) => m.role === "assistant" && !m.pending && !m.error && m.answer);
}

// ---------- сборка ----------

interface Candidate {
  fact: SummaryFact;
  product: ProductKey;
  overlap: number;
  order: number;
}

/** Предложения ответов с опорой в документах продуктов, по продуктам. */
function collectFacts(session: Session, kb?: KbLike | null): Candidate[] {
  const out: Candidate[] = [];
  let order = 0;
  for (const m of session.messages) {
    const a = usableAnswer(m);
    if (!a) continue;
    const content = squash(m.content || a.text);
    for (const c of a.citations ?? []) {
      order++;
      const text = squash(c.sentence);
      if (c.question || text.endsWith("?")) continue;
      if (c.unsupported_numbers?.length) continue;
      if (text.length < MIN_FACT_CHARS || text.length > MAX_FACT_CHARS) continue;
      // Только то, что клиент действительно видел в ответе: предложение должно быть в тексте сообщения.
      if (!content.includes(text)) continue;
      const support = c.support.filter((s) => s.overlap >= MIN_OVERLAP);
      if (!support.length) continue;
      const sources: SummarySource[] = support.map((s) => ({
        chunkId: s.id,
        doc: s.doc,
        docTitle: docTitle(kb, s.doc, s.title),
        section: lastHeading(s.path) || docTitle(kb, s.doc, s.title),
        href: `/kb?chunk=${encodeURIComponent(s.id)}`,
      }));
      for (const p of PRODUCTS) {
        const own = support.filter(
          (s) => (s.doc === p.doc || fileName(s.doc) === fileName(p.doc)) && s.overlap >= PRODUCT_MIN_OVERLAP,
        );
        if (!own.length) continue;
        out.push({
          fact: { text, messageId: m.id, sources },
          product: p.key,
          overlap: Math.max(...own.map((s) => s.overlap)),
          order,
        });
      }
    }
  }
  return out;
}

export function buildSummary(session: Session, kb?: KbLike | null): ConsultationSummary {
  const passport = session.passport;
  const values = new Map(
    (passport?.fields ?? []).filter((f) => f.value?.trim()).map((f) => [f.key, f.value!.trim()] as const),
  );

  const asked = session.messages
    .filter((m) => m.role === "user" && m.content.trim())
    .map((m) => squash(maskContacts(m.content, passport)));

  const candidates = collectFacts(session, kb);

  // Порядок продуктов: как в паспорте (первый — тот, о котором говорили первым), затем остальные по ответам.
  const keys: ProductKey[] = [];
  for (const c of passport?.product_candidates ?? []) {
    if (PRODUCTS.some((p) => p.key === c.product) && !keys.includes(c.product as ProductKey)) {
      keys.push(c.product as ProductKey);
    }
  }
  for (const c of candidates) if (!keys.includes(c.product)) keys.push(c.product);

  const products: SummaryProduct[] = keys.map((key) => {
    const meta = PRODUCTS.find((p) => p.key === key)!;
    const seen = new Set<string>();
    const facts = candidates
      .filter((c) => c.product === key)
      .sort((a, b) => b.overlap - a.overlap || a.order - b.order)
      .filter((c) => !seen.has(c.fact.text) && !!seen.add(c.fact.text))
      .slice(0, MAX_FACTS_PER_PRODUCT)
      .sort((a, b) => a.order - b.order)
      .map((c) => c.fact);
    return { key, label: meta.label, docTitle: docTitle(kb, meta.doc), facts };
  });

  // Чек-лист: под каждый обсуждённый продукт; если продукт не определился — для первичного понимания задачи.
  const listKeys: ChecklistKey[] = keys.length ? keys : ["general"];
  const checklists: SummaryChecklist[] = listKeys.map((key) => {
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
    title: session.title,
    startedAt: session.createdAt,
    updatedAt: session.updatedAt,
    questions: asked.slice(0, MAX_QUESTIONS),
    moreQuestions: Math.max(0, asked.length - MAX_QUESTIONS),
    passport: (passport?.fields ?? [])
      .filter((f) => f.group !== "contacts" && values.has(f.key))
      .map((f) => ({ key: f.key, label: f.label, value: values.get(f.key)! })),
    products,
    checklistNote: CHECKLIST_NOTE,
    checklists,
    leadId: session.lead?.id || undefined,
    disclaimer: { ...DISCLAIMER, href: kbSectionHref(kb, KB_DOC, DISCLAIMER_SECTION) },
  };
}

/** Имя файла при «Сохранить как PDF»: браузер берёт его из заголовка документа. */
export function summaryFileTitle(summary: Pick<ConsultationSummary, "updatedAt">): string {
  const d = new Date(summary.updatedAt);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `Итоги консультации EnergyTool ${dd}.${mm}.${d.getFullYear()}`;
}
