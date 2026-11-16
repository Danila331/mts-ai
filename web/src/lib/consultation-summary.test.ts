// node --experimental-strip-types --test src/lib/*.test.ts (npm test): сборка «Итогов консультации» (T10).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  CHECKLISTS,
  CHECKLIST_NOTE,
  CHECKLIST_SECTION,
  DISCLAIMER,
  DISCLAIMER_SECTION,
  KB_DOC,
  MAX_FACTS_PER_PRODUCT,
  PRODUCTS,
  type ConsultationSummary,
  buildSummary,
  canSummarize,
  maskContacts,
  squash,
} from "./consultation-summary.ts";
import type { AnswerPayload, Citation, Message, Passport, Session } from "./types.ts";

const KB_ROOT = new URL("../../../knowledge-base/", import.meta.url);
const kbText = (doc: string) => readFileSync(new URL(doc, KB_ROOT), "utf8");

/** Текст раздела «## name» или «### name» до следующего заголовка того же или более высокого уровня. */
function section(md: string, name: string): string {
  const m = md.match(new RegExp(`^(#{2,3}) ${name}\\s*$`, "m"));
  assert.ok(m && m.index !== undefined, `в базе нет раздела «${name}»`);
  const level = m[1].length;
  const rest = md.slice(m.index + m[0].length);
  const end = rest.search(new RegExp(`\\n#{2,${level}} `));
  return end >= 0 ? rest.slice(0, end) : rest;
}

const reference = kbText(KB_DOC);
const checklistPart = section(reference, CHECKLIST_SECTION);

// ---------- фикстура: разговор о солнечной станции с паспортом, заявкой и «плохими» предложениями ----------

const SOLAR = "20-products/23-solar.md";
const OREM = "20-products/21-orem.md";

const cite = (sentence: string, support: Citation["support"], extra: Partial<Citation> = {}): Citation => ({
  sentence,
  question: sentence.trim().endsWith("?"),
  support,
  unsupported_numbers: [],
  ...extra,
});

const sup = (id: string, doc: string, path: string, overlap: number) => ({ id, doc, path, overlap, numbers: [] });

function answer(citations: Citation[], extra: Partial<AnswerPayload> = {}): AnswerPayload {
  return {
    id: "a",
    text: citations.map((c) => c.sentence).join(" "),
    fallback: false,
    error: "",
    mode: "chat",
    timings: {},
    guard: {},
    trace: "",
    sources: [],
    citations,
    retrieval: null,
    prompt: [],
    prompt_chars: 0,
    model: "test",
    ...extra,
  };
}

let n = 0;
const user = (content: string): Message => ({ id: `u${++n}`, role: "user", content, createdAt: n });
const bot = (a: AnswerPayload, content = a.text): Message => ({
  id: `b${++n}`,
  role: "assistant",
  content,
  createdAt: n,
  answer: a,
});

const FACT_1 = "Солнечная станция на кровле снижает покупку электроэнергии из сети в дневные часы.";
const FACT_2 = "Станция может работать параллельно с сетью без отказа от централизованного электроснабжения.";
const FACT_3 = "Мониторинг выработки доступен в личном кабинете.";
const NUMBERED = "Окупаемость станции составит 3 года при тарифе 9 рублей.";
const HALLUCINATED = "МТС гарантирует экономию половины платежа за электроэнергию.";
const WEAK = "Это зависит от многих факторов на объекте клиента.";
const QUESTION = "Какая площадь кровли у вашего склада?";
const OREM_FACT = "Выход на оптовый рынок МТС берёт на себя под ключ.";
const LEAD_SUMMARY = "Клиент — склад, интересуется СЭС, горячая заявка, перезвонить завтра в 10:00.";

const passport: Passport = {
  fields: [
    { key: "org_type", label: "Тип организации", group: "general", value: "Склад", source: "bot" },
    { key: "region", label: "Регион", group: "general", value: "Московская область", source: "client" },
    { key: "object_type", label: "Тип объекта", group: "general", value: "Складской комплекс", source: "bot" },
    { key: "task", label: "Задача", group: "general", value: "снижение платежа", source: "bot" },
    { key: "connected_power", label: "Присоединённая мощность", group: "general" },
    { key: "site_area", label: "Площадь и тип кровли или площадки", group: "solar", value: "плоская кровля", source: "bot" },
    { key: "name", label: "Как к вам обращаться", group: "contacts", value: "Тестов Тест Тестович", source: "client" },
    { key: "phone", label: "Телефон", group: "contacts", value: "+79000000000", source: "client" },
    { key: "company", label: "Компания", group: "contacts", value: "ООО Учебный склад", source: "client" },
  ],
  product_candidates: [{ product: "solar", sections: ["s1"] }],
  product: "solar",
  product_label: "Солнечная станция",
  filled: 3,
  total: 6,
  handoff_agreed: true,
  ready_for_lead: true,
};

const messages: Message[] = [
  user("Склад в Московской области, хотим снизить платёж. Подойдёт солнечная станция?"),
  bot(
    answer([
      cite(FACT_1, [sup("s1", SOLAR, "Что это", 0.8)]),
      cite(NUMBERED, [sup("s2", SOLAR, "Как считается эффект", 0.7)], { unsupported_numbers: ["3", "9"] }),
      cite(WEAK, [sup("s3", SOLAR, "Кому подходит", 0.31)]),
      cite(QUESTION, [sup("s4", SOLAR, "Размещение", 0.9)]),
    ]),
  ),
  user("А если сеть отключат? Меня зовут Тестов Тест Тестович, телефон +7 900 000-00-00, test@example.com"),
  bot(
    answer([
      cite(FACT_2, [sup("s5", SOLAR, "Два типа станций", 0.6), sup("x1", "10-energy/15-microgeneration.md", "Что это", 0.55)]),
      cite(FACT_3, [sup("s6", SOLAR, "Обслуживание и мониторинг", 0.95)]),
      cite(OREM_FACT, [sup("o1", OREM, "Что это", 0.7)]),
    ]),
  ),
  // Ответ, где предложение из опоры не совпадает с показанным текстом (guard переписал), — не берём.
  bot(answer([cite(HALLUCINATED, [sup("s7", SOLAR, "Что это", 0.9)])]), "Точную экономию по объекту посчитает специалист."),
  // Запасной ответ без модели — фактов из него не берём.
  bot(answer([cite("Солнечные станции работают даже зимой при низком солнце.", [sup("s8", SOLAR, "Что это", 0.9)])], { fallback: true })),
];

const session: Session = {
  id: "sess-1",
  title: "Склад в Московской области",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_600_000,
  messages,
  passport,
  lead: { id: "L-0042", summary: LEAD_SUMMARY },
};

const kb = {
  docs: [
    {
      doc: KB_DOC,
      title: "Расчёт по объекту и обращение к специалисту",
      chunks: [
        { id: "c-free", path: DISCLAIMER_SECTION },
        { id: "c-solar", path: `${CHECKLIST_SECTION} > ${CHECKLISTS.solar.heading}` },
      ],
    },
    { doc: SOLAR, title: "Солнечные электростанции под ключ", chunks: [{ id: "s1", path: "Что это" }] },
  ],
};

/** Все строки документа, которые увидит клиент, с указанием, откуда они обязаны быть. */
function contentStrings(s: ConsultationSummary) {
  return {
    facts: s.products.flatMap((p) => p.facts.map((f) => f.text)),
    kb: [
      s.checklistNote,
      ...s.checklists.flatMap((c) => [...c.items.map((i) => i.text), ...c.notes]),
      s.disclaimer.intro,
      s.disclaimer.lead,
      ...s.disclaimer.points,
      s.disclaimer.timing,
    ],
    passport: s.passport.map((p) => p.value),
    questions: s.questions,
  };
}

// ---------- тесты ----------

describe("ограничение №1: чек-лист и оговорки — дословно из базы", () => {
  test("первая строка раздела «Какие сведения могут понадобиться»", () => {
    assert.ok(squash(checklistPart).startsWith(CHECKLIST_NOTE));
  });

  test("каждый пункт и абзац чек-листа есть в своём подразделе базы", () => {
    for (const [key, list] of Object.entries(CHECKLISTS)) {
      const part = section(checklistPart, list.heading);
      const bullets = part
        .split(/\n(?=\s*-\s)/)
        .filter((b) => /^\s*-\s/.test(b))
        // Последний пункт тянет за собой абзацы после списка — отрезаем по пустой строке.
        .map((b) => squash(b.split(/\n\s*\n/)[0].replace(/^\s*-\s+/, "")).replace(/[;.]$/, ""));
      assert.deepEqual(
        list.items.map((i) => i.text),
        bullets,
        `пункты ${key} не совпадают со списком в базе`,
      );
      for (const note of list.notes ?? []) assert.ok(squash(part).includes(note), `абзаца нет в базе: «${note}»`);
    }
  });

  test("у каждого продукта есть свой подраздел, а общий — для первичного понимания задачи", () => {
    for (const p of PRODUCTS) assert.ok(CHECKLISTS[p.key], `нет чек-листа для ${p.key}`);
    assert.equal(CHECKLISTS.general.heading, "Для первичного понимания задачи");
  });

  test("оговорки — фразы раздела «Бесплатная предварительная оценка»", () => {
    const part = squash(section(reference, DISCLAIMER_SECTION));
    for (const phrase of [DISCLAIMER.intro, DISCLAIMER.lead, ...DISCLAIMER.points, DISCLAIMER.timing]) {
      assert.ok(part.includes(phrase), `оговорки нет в базе: «${phrase}»`);
    }
    assert.ok(DISCLAIMER.points.includes("не является коммерческим предложением"));
  });

  test("продукты и документы — те же, что у сервера", () => {
    const go = readFileSync(new URL("../../../backend/internal/passport/passport.go", import.meta.url), "utf8");
    for (const p of PRODUCTS) assert.ok(go.includes(`"${p.label}", "${p.doc}"`), `${p.key} расходится с passport.go`);
  });

  test("документы продуктов существуют в базе", () => {
    for (const p of PRODUCTS) assert.ok(kbText(p.doc).length > 0);
  });
});

describe("сборка итогов из сессии", () => {
  const s = buildSummary(session, kb);

  test("нужные секции: вопросы, паспорт, продукты, чек-лист, заявка, оговорка", () => {
    assert.equal(s.questions.length, 2);
    assert.ok(s.passport.length > 0);
    assert.deepEqual(
      s.products.map((p) => p.key),
      ["solar", "wholesale"],
      "сначала продукт из паспорта, затем по опоре ответов",
    );
    assert.deepEqual(
      s.checklists.map((c) => c.heading),
      [CHECKLISTS.solar.heading, CHECKLISTS.wholesale.heading],
    );
    assert.equal(s.leadId, "L-0042");
    assert.ok(s.disclaimer.points.includes("не является коммерческим предложением"));
  });

  test("факты — 1–2 дословных предложения ответов с опорой, лучшие по совпадению, в порядке разговора", () => {
    const solar = s.products.find((p) => p.key === "solar")!;
    assert.ok(solar.facts.length <= MAX_FACTS_PER_PRODUCT);
    assert.deepEqual(
      solar.facts.map((f) => f.text),
      [FACT_1, FACT_3],
    );
    assert.equal(solar.docTitle, "Солнечные электростанции под ключ");
    const [first] = solar.facts;
    assert.deepEqual(
      first.sources.map((x) => [x.section, x.href]),
      [["Что это", "/kb?chunk=s1"]],
    );
    assert.deepEqual(s.products.find((p) => p.key === "wholesale")!.facts.map((f) => f.text), [OREM_FACT]);
  });

  test("не попадают: числа без опоры, слабая опора, вопросы клиенту, переписанное guard, запасной ответ", () => {
    const facts = contentStrings(s).facts.join("\n");
    for (const bad of [NUMBERED, WEAK, QUESTION, HALLUCINATED, "работают даже зимой"]) {
      assert.ok(!facts.includes(bad), `попало в итоги: «${bad}»`);
    }
  });

  test("нет текста, которого не было в ответах, паспорте, репликах клиента или базе", () => {
    const answers = messages.filter((m) => m.role === "assistant").map((m) => squash(m.content));
    const c = contentStrings(s);
    for (const f of c.facts) assert.ok(answers.some((a) => a.includes(f)), `факта нет в ответах: «${f}»`);
    for (const k of c.kb) assert.ok(squash(reference).includes(k), `строки нет в базе: «${k}»`);
    const values = passport.fields.map((f) => f.value);
    for (const v of c.passport) assert.ok(values.includes(v), `значения нет в паспорте: «${v}»`);
    const asked = messages.filter((m) => m.role === "user").map((m) => squash(maskContacts(m.content, passport)));
    for (const q of c.questions) assert.ok(asked.includes(q));
  });

  test("резюме заявки от модели и контакты в документ не попадают", () => {
    const all = JSON.stringify(s);
    assert.ok(!all.includes(LEAD_SUMMARY));
    assert.ok(!all.includes("10:00"), "никакого обещания времени звонка");
    assert.ok(!s.passport.some((p) => ["name", "phone", "company"].includes(p.key)));
    for (const pii of ["Тестов Тест Тестович", "+7 900 000-00-00", "+79000000000", "test@example.com"]) {
      assert.ok(!all.includes(pii), `в документе контакт: ${pii}`);
    }
    assert.match(s.questions[1], /\[имя скрыто\].*\[телефон скрыт\].*\[e-mail скрыт\]/);
  });

  test("в собственных строках модуля нет рублей и чисел", () => {
    const c = contentStrings(s);
    for (const text of [...c.kb, ...s.checklists.map((x) => x.heading)]) {
      assert.doesNotMatch(text, /₽|руб/i);
      for (const num of text.match(/\d+/g) ?? []) assert.ok(squash(reference).includes(num));
    }
  });

  test("чек-лист отмечает, что клиент уже сообщил", () => {
    const solar = s.checklists.find((c) => c.key === "solar")!;
    const provided = Object.fromEntries(solar.items.map((i) => [i.text, i.provided]));
    assert.equal(provided["регион и характеристики объекта"], true);
    assert.equal(provided["площадь и тип кровли либо свободной площадки"], true);
    assert.equal(provided["присоединённая мощность"], false, "пустое поле паспорта");
    assert.equal(solar.href, "/kb?chunk=c-solar");
    assert.equal(s.disclaimer.href, "/kb?chunk=c-free");
  });

  test("без базы ссылки ведут на документ", () => {
    const bare = buildSummary(session);
    assert.equal(bare.checklists[0].href, `/kb?doc=${encodeURIComponent(KB_DOC)}`);
    assert.equal(bare.products[0].docTitle, "Солнечная станция");
    assert.equal(bare.products[0].facts[0].sources[0].docTitle, "Солнечная станция", "не имя файла");
  });
});

describe("краевые случаи", () => {
  test("продукт с «честным нет» — в итогах с причиной, но без чек-листа (живой прогон: магазин на 40 кВт)", () => {
    const reason = "Присоединённая мощность ниже 750 кВт - выход на оптовый рынок невозможен.";
    const a = answer(
      [
        cite("Выход на оптовый рынок невозможен при присоединённой мощности ниже 750 кВт для вашего магазина.", [
          sup("o1", OREM, "Порог доступа определяется присоединённой мощностью", 0.8),
        ]),
      ],
      {
        honest_no: [
          {
            rule: "orem_power",
            product: "Выход на оптовый рынок",
            reason,
            fact: "40 кВт",
            section: { chunk_id: "o1", doc: OREM, title: "Оптовый рынок", path: "Порог" },
            alternative: null,
          },
        ],
      },
    );
    const s = buildSummary({
      id: "h",
      title: "Магазин",
      createdAt: 0,
      updatedAt: 0,
      messages: [user("У нас магазин, 40 кВт, хотим на оптовый рынок."), bot(a)],
    });
    const orem = s.products.find((p) => p.key === "wholesale");
    assert.equal(orem?.notFit, reason);
    assert.ok(!s.checklists.some((c) => c.key === "wholesale"), "данные под то, что не подойдёт, не просим");
    assert.deepEqual(s.checklists.map((c) => c.key), ["general"]);
  });


  test("случайное совпадение с разделом продукта не делает его обсуждённым (живой прогон)", () => {
    const s = buildSummary({
      id: "w",
      title: "Склады",
      createdAt: 0,
      updatedAt: 0,
      messages: [
        user("У нас три склада и около 40 счётчиков, хотим собирать показания автоматически."),
        bot(
          answer([
            cite("Она подходит для любого количества приборов и позволяет вести учёт по объектам.", [
              sup("p1", "20-products/22-askue.md", "Кому подходит", 0.62),
            ]),
            cite("Для оценки подключения важно понять, какие модели приборов установлены и как организована передача данных.", [
              sup("r1", "20-products/25-meter-reading.md", "Факты, которые можно утверждать", 0.5),
            ]),
          ]),
        ),
      ],
    });
    assert.deepEqual(s.products.map((p) => p.key), ["platform"]);
    assert.deepEqual(s.checklists.map((c) => c.key), ["platform"], "без пунктов про фотографии");
  });


  test("без паспорта и продуктов — общий чек-лист", () => {
    const s = buildSummary({
      id: "x",
      title: "Тарифы",
      createdAt: 0,
      updatedAt: 0,
      messages: [user("Что такое ценовая категория?"), bot(answer([cite("Ценовая категория определяет порядок расчёта за электроэнергию.", [sup("t1", "10-energy/11-price-categories.md", "Что это", 0.9)])]))],
    });
    assert.deepEqual(s.products, []);
    assert.deepEqual(s.checklists.map((c) => c.key), ["general"]);
    assert.equal(s.leadId, undefined);
    assert.deepEqual(s.passport, []);
  });

  test("кнопка доступна только после первого завершённого ответа", () => {
    const base = { id: "x", title: "", createdAt: 0, updatedAt: 0 };
    assert.equal(canSummarize(undefined), false);
    assert.equal(canSummarize({ ...base, messages: [] }), false);
    assert.equal(
      canSummarize({ ...base, messages: [user("Вопрос"), { id: "p", role: "assistant", content: "", createdAt: 1, pending: true }] }),
      false,
    );
    assert.equal(canSummarize({ ...base, messages: [user("Вопрос"), bot(answer([]), "Ответ")] }), true);
  });

  test("маскирование контактов в репликах", () => {
    assert.equal(maskContacts("звоните 8 (900) 000-00-00"), "звоните [телефон скрыт]");
    assert.equal(maskContacts("мощность 150 кВт, 2025 год"), "мощность 150 кВт, 2025 год");
  });
});
