// node --experimental-strip-types --test src/lib/*.test.ts (npm test): «Пакет для правления» СНТ, УК, ТСЖ (T22).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  BOARD_CHECKLISTS,
  CAVEAT_QUOTES,
  HONEST_NO_TITLE,
  LIMIT_QUOTES,
  ORG_QUOTES,
  type BoardQuote,
  boardOwnTexts,
  buildBoardPack,
  defaultFormat,
} from "./board-pack.ts";
import { CHECKLISTS, DISCLAIMER_SECTION, KB_DOC, squash } from "./consultation-summary.ts";
import type { AnswerPayload, HonestNo, Message, Passport, Session } from "./types.ts";

const KB_ROOT = new URL("../../../knowledge-base/", import.meta.url);
const kbText = (doc: string) => readFileSync(new URL(doc, KB_ROOT), "utf8");

/** Текст раздела: от его заголовка до следующего заголовка любого уровня (## и ###). */
function sectionText(doc: string, heading: string): string {
  const lines = kbText(doc).split("\n");
  const start = lines.findIndex((l) => /^#{2,4} /.test(l) && l.replace(/^#+ /, "").trim() === heading);
  assert.ok(start >= 0, `в ${doc} нет раздела «${heading}»`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,4} /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** Текст как читает человек: пробелы схлопнуты, выделение `**` и ссылки `[текст](файл)` убраны. */
const plain = (md: string) => squash(md.replace(/\*\*/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"));

/** Ячейки таблицы раздела: в базе они перенесены по строкам и перемешаны, поэтому режем по колонкам рамки. */
function tableCells(md: string): string[] {
  const lines = md.split("\n");
  const rule = lines.find((l) => /^\s+-{3,}\s+-{3,}/.test(l));
  if (!rule) return [];
  const cols = [...rule.matchAll(/-{3,}/g)].map((m) => m.index!);
  const cells: string[][] = [];
  let row: string[] | null = null;
  for (const line of lines.slice(lines.indexOf(rule) + 1)) {
    if (/^\s*$/.test(line)) {
      row = null; // строки таблицы разделены пустой строкой
      continue;
    }
    if (/^\s+-{3,}/.test(line)) continue;
    if (!/^ {2}/.test(line)) break;
    if (!row) cells.push((row = cols.map(() => "")));
    cols.forEach((c, i) => (row![i] += ` ${line.slice(c, cols[i + 1])}`));
  }
  return cells.flat().map(squash).filter(Boolean);
}

/** Цитата — дословный фрагмент раздела или одна ячейка его таблицы. */
function inKb(q: BoardQuote): boolean {
  const md = sectionText(q.doc, q.section);
  return plain(md).includes(squash(q.text)) || tableCells(md).some((c) => c.includes(squash(q.text)));
}

// ---------- сессия: СНТ, роль housing ----------

const section = (id: string, doc: string, path: string, title: string) => ({ chunk_id: id, doc, title, path });

const SNT_NO: HonestNo = {
  rule: "invoice",
  product: "Облачная платформа учёта",
  reason:
    "Требуется выставление квитанций и расчёты с абонентами в рублях. Платформа ведёт учёт в киловатт-часах и готовит данные для начисления, но сама счета не выставляет.",
  fact: "квитанции",
  section: section("h1", "20-products/22-askue.md", "Кому подходит > Не подходит, если", "Облачная платформа учёта электроэнергии"),
  alternative: null,
};

function answer(extra: Partial<AnswerPayload> = {}): AnswerPayload {
  return {
    id: "a",
    text: "Платформа учёта подходит товариществам. Окупаемость составит 2 года при тарифе 9 рублей.",
    fallback: false,
    error: "",
    mode: "chat",
    timings: {},
    guard: {},
    trace: "",
    sources: [],
    citations: [
      {
        sentence: "Окупаемость составит 2 года при тарифе 9 рублей.",
        question: false,
        support: [{ id: "p1", doc: "20-products/22-askue.md", path: "Что даёт клиенту", overlap: 0.9, numbers: [] }],
        unsupported_numbers: [],
      },
    ],
    retrieval: null,
    prompt: [],
    prompt_chars: 0,
    model: "test",
    ...extra,
  };
}

let n = 0;
const user = (content: string): Message => ({ id: `u${++n}`, role: "user", content, createdAt: n });
const bot = (a: AnswerPayload): Message => ({ id: `b${++n}`, role: "assistant", content: a.text, createdAt: n, answer: a });

const passport: Passport = {
  fields: [
    { key: "org_type", label: "Тип организации", group: "general", value: "СНТ", source: "bot" },
    { key: "meters", label: "Количество и тип приборов", group: "platform", value: "120 приборов", source: "client" },
    { key: "name", label: "Как к вам обращаться", group: "contacts", value: "Тестов Тест Тестович", source: "client" },
    { key: "phone", label: "Телефон", group: "contacts", value: "+79000000000", source: "client" },
  ],
  product_candidates: [{ product: "platform", sections: ["p1"] }],
  product: "platform",
  product_label: "Платформа учёта",
  filled: 2,
  total: 6,
  handoff_agreed: false,
  ready_for_lead: false,
};

const session: Session = {
  id: "snt-1",
  title: "СНТ платит больше, чем потребляет",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_600_000,
  role: "housing",
  roleSource: "client",
  messages: [
    user("Мы СНТ, хотим отключать неплательщиков и выставлять им квитанции. Телефон +7 900 000-00-00"),
    bot(answer({ honest_no: [SNT_NO, SNT_NO] })),
    user("Можно принимать показания от жителей?"),
    bot(answer()),
  ],
  passport,
};

const kb = {
  docs: [
    {
      doc: "20-products/20-portfolio.md",
      title: "Продукты",
      chunks: [
        { id: "k-org", path: "Навигация по типу компании > Управляющая компания, ТСЖ, СНТ, товарищество" },
        { id: "k-link", path: "Как продукты связаны между собой" },
      ],
    },
    { doc: "20-products/22-askue.md", title: "Платформа учёта", chunks: [{ id: "k-not", path: "Что мы не делаем" }] },
  ],
};

// ---------- тесты ----------

describe("тексты пакета — дословно из базы", () => {
  for (const [name, quotes] of [
    ["о продукте для организации", ORG_QUOTES],
    ["чего продукт не делает", LIMIT_QUOTES],
    ["оговорки базы", CAVEAT_QUOTES],
  ] as const) {
    for (const q of quotes) {
      test(`${name}: «${q.text.slice(0, 48)}…» есть в «${q.section}»`, () => {
        assert.ok(inKb(q), `нет в ${q.doc} › ${q.section}: ${q.text}`);
      });
    }
  }

  test("чек-листы и оговорки об оценке — те же строки базы, что в итогах T10", () => {
    const pack = buildBoardPack(session, kb);
    const md = plain(sectionText(KB_DOC, DISCLAIMER_SECTION));
    for (const t of [pack.disclaimer.lead, ...pack.disclaimer.points, pack.disclaimer.timing]) {
      assert.ok(md.includes(squash(t)), t);
    }
    assert.deepEqual(pack.checklists.map((c) => c.key), [...BOARD_CHECKLISTS]);
    for (const c of pack.checklists) {
      const part = plain(sectionText(KB_DOC, c.heading));
      for (const item of c.items) assert.ok(part.includes(squash(item.text)), `${c.heading}: ${item.text}`);
    }
    assert.equal(CHECKLISTS.platform.heading, pack.checklists[0].heading);
  });

  test("явные ограничения из ROADMAP на месте: счета и верификация фото", () => {
    const limits = LIMIT_QUOTES.map((q) => q.text).join(" ");
    assert.match(limits, /Не выставляем счета и квитанции/);
    assert.match(limits, /только после верификации/);
  });
});

describe("нет денег и обещаний", () => {
  const MONEY = /\d[\d\s.,]*\s*(?:₽|руб|тыс|млн|%)|окупаем|экономи|стоимост|тариф|прибыл|выгод|срок[ие]? (?:внедрен|окупаем)/i;
  const PROMISE = /гарантир|обещаем|обязуем|точно (?:будет|снизит|сэконом)|отключ(?:ать|ение|им)\s+(?:должник|неплательщик)|неплательщик|должник/i;

  test("ни одна строка документа не содержит сумм, окупаемости и обещаний", () => {
    const pack = buildBoardPack(session, kb);
    for (const text of boardOwnTexts(pack)) {
      assert.doesNotMatch(text, MONEY, text);
      assert.doesNotMatch(text, PROMISE, text);
    }
  });

  test("ответы бота с числами и «окупаемостью» в документ не попадают", () => {
    const pack = buildBoardPack(session, kb);
    const all = JSON.stringify(pack);
    assert.ok(!all.includes("Окупаемость"));
    assert.ok(!all.includes("9 рублей"));
  });

  test("собственные тексты документа описывают продукт словами базы, а не «отключением должников»", () => {
    const pack = buildBoardPack(session, kb);
    const own = boardOwnTexts(pack).join(" ");
    assert.match(own, /дистанционное управление нагрузкой/);
    assert.doesNotMatch(own, /неплательщик|должник/i);
  });

  test("контакты клиента в документ не попадают", () => {
    const all = JSON.stringify(buildBoardPack(session, kb));
    assert.ok(!all.includes("+7 900") && !all.includes("79000000000") && !all.includes("Тестов Тест"));
    assert.ok(all.includes("[телефон скрыт]"));
  });
});

describe("сборка пакета", () => {
  test("вопросы и паспорт — со слов клиента; продукты — названия, без фактов бота", () => {
    const pack = buildBoardPack(session, kb);
    assert.equal(pack.questions.length, 2);
    assert.deepEqual(pack.passport.map((p) => p.key), ["org_type", "meters"]);
    assert.deepEqual(pack.discussed, ["Платформа учёта"]);
  });

  test("«Честные нет» из ответов (T26) переносятся с разделом базы, без повторов", () => {
    const pack = buildBoardPack(session, kb);
    assert.equal(HONEST_NO_TITLE, "Честно: не подойдёт");
    assert.equal(pack.honestNo.length, 1);
    assert.equal(pack.honestNo[0].reason, SNT_NO.reason);
    assert.equal(pack.honestNo[0].link?.href, "/kb?chunk=h1");
  });

  test("без плашек в ответах раздела «не подойдёт» нет, а границы базы всё равно есть", () => {
    const quiet: Session = { ...session, messages: [user("Что вы делаете для СНТ?"), bot(answer())] };
    const pack = buildBoardPack(quiet, kb);
    assert.deepEqual(pack.honestNo, []);
    assert.ok(pack.limits.length >= 4);
  });

  test("ссылки: id раздела — из /api/kb, без базы — на документ", () => {
    const pack = buildBoardPack(session, kb);
    assert.equal(pack.org[0].href, "/kb?chunk=k-org");
    assert.equal(pack.org[3].href, "/kb?chunk=k-link");
    assert.equal(pack.limits[0].href, "/kb?chunk=k-not");
    assert.equal(buildBoardPack(session).limits[0].href, "/kb?doc=20-products%2F22-askue.md");
  });

  test("чек-лист: что клиент уже сообщил — отмечено", () => {
    const pack = buildBoardPack(session, kb);
    const platform = pack.checklists.find((c) => c.key === "platform")!;
    assert.equal(platform.items.find((i) => i.text === "тип организации")?.provided, true);
    assert.equal(platform.items.find((i) => i.text === "количество и тип приборов")?.provided, true);
    assert.equal(platform.items.find((i) => i.text.startsWith("существующая схема"))?.provided, false);
  });
});

describe("когда показывать пакет", () => {
  test("роль housing — по умолчанию пакет, иначе — обычные итоги", () => {
    assert.equal(defaultFormat(session), "board");
    assert.equal(defaultFormat({ ...session, role: "engineer" }), "summary");
    assert.equal(defaultFormat({ ...session, role: "" }), "summary");
    assert.equal(defaultFormat({ ...session, role: undefined }), "summary");
    assert.equal(defaultFormat(undefined), "summary");
  });
});
