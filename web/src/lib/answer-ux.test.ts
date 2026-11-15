// node --experimental-strip-types --test src/lib/*.test.ts (npm test): UX ответа и диалога (T31).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  AI_DISCLAIMER,
  AI_INTRO,
  AI_LABEL,
  ANSWER_PAD_PX,
  MAX_SUGGESTIONS,
  TASK_BUTTONS,
  followTarget,
  hasUnsentLead,
  hasUsefulAnswer,
  leadAfterText,
  leadChecklists,
  nextFollowing,
  suggestionsFor,
  visibleSuggestions,
} from "./answer-ux.ts";
import { CHECKLISTS, KB_DOC } from "./consultation-summary.ts";
import type { AnswerPayload, Message, Passport, Session } from "./types.ts";

const text = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const answer = (extra: Partial<AnswerPayload> = {}): AnswerPayload => ({
  id: "a",
  text: "Ответ. Какая у вас задача?",
  fallback: false,
  error: "",
  mode: "chat",
  timings: {},
  guard: {},
  trace: "",
  sources: [],
  citations: [],
  retrieval: null,
  prompt: [],
  prompt_chars: 0,
  model: "test",
  ...extra,
});

let n = 0;
const bot = (a: AnswerPayload, extra: Partial<Message> = {}): Message => ({
  id: `b${++n}`,
  role: "assistant",
  content: a.text,
  createdAt: n,
  answer: a,
  ...extra,
});
const user = (content: string): Message => ({ id: `u${++n}`, role: "user", content, createdAt: n });

const passport = (fields: Record<string, string>, extra: Partial<Passport> = {}): Passport => ({
  fields: Object.entries(fields).map(([key, value]) => ({ key, label: key, group: "general", value })),
  product_candidates: [],
  product: "general",
  product_label: "",
  filled: 0,
  total: 0,
  handoff_agreed: false,
  ready_for_lead: false,
  ...extra,
});

const session = (extra: Partial<Session> = {}): Session => ({
  id: "s",
  title: "t",
  createdAt: 1,
  updatedAt: 2,
  messages: [],
  ...extra,
});

describe("метка ИИ", () => {
  test("тексты", () => {
    assert.equal(AI_LABEL, "ИИ-ассистент");
    assert.match(AI_INTRO, /ИИ-ассистент/);
    assert.match(AI_DISCLAIMER, /материалах EnergyTool и могут быть неточными/);
  });
});

describe("быстрые ответы", () => {
  const ok = ["Снизить платёж", "Найти потери", "Не знаю"];

  test("показываются под последним ответом", () => {
    assert.deepEqual(suggestionsFor([user("привет"), bot(answer({ suggestions: ok }))]), ok);
  });

  test("не показываются, если ответ печатается, с ошибкой, запасной или после реплики клиента", () => {
    assert.deepEqual(suggestionsFor([bot(answer({ suggestions: ok }), { pending: true })]), []);
    assert.deepEqual(suggestionsFor([bot(answer({ suggestions: ok }), { error: "x" })]), []);
    assert.deepEqual(suggestionsFor([bot(answer({ suggestions: ok, fallback: true }))]), []);
    assert.deepEqual(suggestionsFor([bot(answer({ suggestions: ok })), user("свой ответ")]), []);
    assert.deepEqual(suggestionsFor([bot(answer())]), [], "ядро не прислало кнопок (eval, нет вопроса)");
  });

  test("2–4 строки, без повторов и мусора", () => {
    assert.deepEqual(visibleSuggestions(answer({ suggestions: ["Один"] })), []);
    assert.deepEqual(visibleSuggestions(answer({ suggestions: ["А", "а", "  "] })), []);
    const many = ["1", "2", "3", "4", "5", "6"].map((x) => `Вариант ${x}`);
    assert.equal(visibleSuggestions(answer({ suggestions: many })).length, MAX_SUGGESTIONS);
    assert.deepEqual(visibleSuggestions(answer({ suggestions: ["x".repeat(200), "Да", "Нет"] })), ["Да", "Нет"]);
  });

  test("названную в паспорте задачу не предлагаем снова", () => {
    const p = passport({ task: "поиск потерь" });
    const got = visibleSuggestions(answer({ suggestions: Object.values(TASK_BUTTONS).slice(0, 3).concat("Не знаю") }), p);
    assert.ok(!got.includes(TASK_BUTTONS["поиск потерь"]));
    assert.ok(got.includes("Не знаю"));
  });

  test("после отправленной заявки «передайте менеджеру» не предлагаем", () => {
    const sug = ["Да, передайте менеджеру", "Оставить заявку", "Свяжитесь со мной", "Пока продолжим здесь", "Расскажите подробнее"];
    assert.deepEqual(visibleSuggestions(answer({ suggestions: sug }), undefined, true), ["Пока продолжим здесь", "Расскажите подробнее"]);
    assert.deepEqual(visibleSuggestions(answer({ suggestions: ["Да, передайте менеджеру", "Пока продолжим здесь"] }), undefined, true), []);
    assert.equal(visibleSuggestions(answer({ suggestions: sug })).length, 4, "без заявки кнопки остаются");
    assert.deepEqual(suggestionsFor([bot(answer({ suggestions: ["Да, передайте менеджеру", "Пока продолжим здесь"] }))], undefined, true), []);
  });

  test("кнопки задач совпадают с ядром и закрытым списком паспорта", () => {
    const py = text("../../../scripts/quick_replies.py");
    for (const [task, label] of Object.entries(TASK_BUTTONS)) assert.ok(py.includes(`"${task}":`) && py.includes(`"${label}"`), task);
    const go = text("../../../backend/internal/passport/passport.go");
    for (const task of Object.keys(TASK_BUTTONS)) assert.ok(go.includes(`"${task}"`), task);
  });
});

describe("первый полезный ответ", () => {
  test("запасной, ошибочный, уточняющий и печатающийся ответы не считаются", () => {
    assert.equal(hasUsefulAnswer([bot(answer({ fallback: true }))]), false);
    assert.equal(hasUsefulAnswer([bot(answer({ error: "boom" }))]), false);
    assert.equal(hasUsefulAnswer([bot(answer({ route: "clarify" }))]), false);
    assert.equal(hasUsefulAnswer([bot(answer(), { pending: true })]), false);
    assert.equal(hasUsefulAnswer([user("вопрос")]), false);
    assert.equal(hasUsefulAnswer([bot(answer({ fallback: true })), bot(answer())]), true);
  });
});

describe("после заявки", () => {
  const lines = leadAfterText("42");

  test("номер заявки, без срока и обещаний по времени", () => {
    assert.match(lines[0], /Ваша заявка №42 принята/);
    assert.match(lines.join(" "), /учитывая удобное время/);
    assert.match(lines.join(" "), /Консультация продолжается/);
    assert.doesNotMatch(
      lines.join(" "),
      /\d+\s*(мин|час|ч\b|дн|сут|рабоч)|в течение|сегодня|завтра|скоро|немедленно|перезвон(им|ит) в|специалист[ауе]? \S+ \S+вич/i,
    );
  });

  test("чек-лист «что подготовить» — пункты раздела базы, которые клиент ещё не назвал", () => {
    const s = session({
      lead: { id: "42", summary: "s" },
      passport: passport({ region: "Московская область", object_type: "Склад" }, {
        product_candidates: [{ product: "solar", sections: ["x"] }],
        product: "solar",
      }),
    });
    const lists = leadChecklists(s);
    assert.equal(lists.length, 1);
    assert.equal(lists[0].key, "solar");
    const base = CHECKLISTS.solar.items.map((i) => i.text);
    for (const item of lists[0].items) assert.ok(base.includes(item.text));
    assert.ok(lists[0].items.length < base.length, "названный регион исключён");
    assert.ok(text(`../../../knowledge-base/${KB_DOC}`).includes("Для солнечной станции"));
  });

  test("без продукта — общий чек-лист первичного понимания задачи", () => {
    const lists = leadChecklists(session({ lead: { id: "1", summary: "" } }));
    assert.equal(lists[0].key, "general");
  });
});

describe("«Новый диалог»", () => {
  test("подтверждение, если заявка начата и не отправлена", () => {
    assert.equal(hasUnsentLead(undefined), false);
    assert.equal(hasUnsentLead(session()), false);
    assert.equal(hasUnsentLead(session({ passport: passport({ region: "Москва" }) })), false);
    assert.equal(hasUnsentLead(session({ passport: passport({ phone: "+7 900 000-00-00" }) })), true);
    assert.equal(hasUnsentLead(session({ passport: passport({}, { handoff_agreed: true }) })), true);
    assert.equal(
      hasUnsentLead(session({ passport: passport({ phone: "+7 900 000-00-00" }), lead: { id: "1", summary: "" } })),
      false,
      "заявка отправлена — подтверждать нечего",
    );
  });
});

describe("прокрутка", () => {
  const box = (scrollTop: number, scrollHeight = 3000, clientHeight = 600) => ({ scrollTop, scrollHeight, clientHeight });

  test("короткий ответ: держим низ", () => {
    assert.equal(followTarget(box(0, 800), 300, true), 200);
  });

  test("длинный ответ: не дальше начала ответа", () => {
    assert.equal(followTarget(box(1000), 1200, true), 1200 - ANSWER_PAD_PX);
    assert.equal(followTarget(box(1188), 1200, true), null, "начало ответа уже наверху — не едем к концу");
  });

  test("человек отмотал вверх — не трогаем", () => {
    assert.equal(followTarget(box(100), 1200, false), null);
  });

  test("прилипшая шапка учитывается отступом", () => {
    assert.equal(followTarget(box(0), 1200, true, 90), 1110);
  });

  test("слежение: вверх отключает, возврат к низу включает, вниз не меняет", () => {
    assert.equal(nextFollowing(true, 1000, box(900)), false);
    assert.equal(nextFollowing(false, 900, box(950)), false);
    assert.equal(nextFollowing(false, 900, box(2390)), true);
    assert.equal(nextFollowing(true, 900, box(1000)), true);
  });
});
