// node --experimental-strip-types --test src/lib/*.test.ts  (npm test)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  CALLBACK_HINT,
  CALLBACK_NOTED,
  CALLBACK_PLAIN,
  CALLBACK_QUESTION,
  CALLBACK_TIMES,
  LEAD_SAVED,
  guessTime,
  leadSavedText,
  timezoneOptions,
  utcOffset,
} from "./callback.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Обещания, которых база не разрешает (раздел «Обратный звонок»): точное время, срок звонка, имя специалиста.
 * Первая часть — без учёта регистра; имя после «менеджер/специалист» — с заглавной буквы.
 */
const PROMISE =
  /\d{1,2}[:.]\d{2}|через \d+|\d+\s*(мин|час)|в течение|сегодня|завтра|перезвоним в|позвоним в|до конца (дня|недели)|в ближайш/i;
const NAMED = /(?:[Сс]пециалист|[Мм]енеджер)\s+[А-ЯЁ][а-яё]+/;
const promises = (s: string) => PROMISE.test(s) || NAMED.test(s);

/** Исходник без комментариев: в них можно писать, чего делать нельзя. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Русский текст из кода: строки и текст JSX — всё, что начинается с кириллицы, до кавычки, тега или скобки. */
const russian = (src: string) => code(src).match(/[А-ЯЁа-яё][^"'`<>{}\n]*/g) ?? [];

/** Компоненты, тексты которых клиент видит до и после отправки заявки. */
const UI_FILES = [
  "../components/chat/inline-lead.tsx",
  "../components/chat/lead-dialog.tsx",
  "../components/chat/callback-picker.tsx",
  "../components/chat/consent.tsx",
  "../components/chat/chat-view.tsx",
  "./callback.ts",
];

describe("T4: удобное время вместо записи на время", () => {
  test("база запрещает обещать точное время звонка и имя специалиста", () => {
    const kb = squash(read("../../../knowledge-base/00-reference/03-calculation-and-requests.md"));
    assert.ok(kb.includes("## Обратный звонок"));
    assert.ok(
      kb.includes("Нельзя обещать точное время звонка, имя специалиста или заранее определённое содержание разговора"),
    );
  });

  test("текст после отправки — как в ROADMAP", () => {
    assert.equal(LEAD_SAVED, "Заявка сохранена. Менеджер учтёт удобное время.");
    assert.equal(leadSavedText({ time: "evening", timezone: "Europe/Moscow" }), LEAD_SAVED);
    assert.equal(leadSavedText({ time: "", timezone: "Europe/Moscow" }), `Заявка сохранена. ${CALLBACK_PLAIN}`);
  });

  test("регулярка ловит обещания и не трогает честные тексты", () => {
    for (const bad of ["Перезвоним в 15:00", "через 5 минут", "Вам позвонит менеджер Анна", "сегодня до конца дня"]) {
      assert.ok(promises(bad), bad);
    }
    for (const ok of [LEAD_SAVED, CALLBACK_NOTED, CALLBACK_PLAIN, CALLBACK_HINT, CALLBACK_QUESTION, "Менеджер МТС"]) {
      assert.ok(!promises(ok), ok);
    }
  });

  test("в строках компонентов заявки нет обещаний точного времени, срока или имени", () => {
    for (const file of UI_FILES) {
      const strings = russian(read(file));
      assert.ok(strings.length > 0, `в ${file} не нашлось текста — путь устарел?`);
      for (const s of strings) assert.ok(!promises(s), `${file}: «${s}»`);
    }
    for (const t of CALLBACK_TIMES) assert.ok(!promises(t.label), t.label);
  });

  test("варианты части дня — те же, что принимает сервер (lead.CallbackTimes)", () => {
    const go = read("../../../backend/internal/lead/callback.go");
    const server = [...go.matchAll(/\{"(\w+)", "[^"]+"\}/g)].map((m) => m[1]);
    assert.deepEqual(
      CALLBACK_TIMES.map((t) => t.value),
      server,
    );
  });
});

describe("подсказки выбора", () => {
  test("часть дня по словам клиента — только если однозначно", () => {
    assert.equal(guessTime("лучше с утра"), "morning");
    assert.equal(guessTime("Звоните вечером"), "evening");
    assert.equal(guessTime("после обеда"), "day");
    assert.equal(guessTime("в любое время"), "any");
    assert.equal(guessTime(""), "");
    assert.equal(guessTime("в 15:00"), "", "точное время не превращается в выбор");
  });

  test("пояс браузера вне списка России — первым; сдвиг считает браузер", () => {
    const at = new Date("2026-11-15T12:00:00Z");
    const ru = timezoneOptions("Europe/Moscow", at);
    assert.equal(ru[0].value, "Europe/Kaliningrad");
    assert.ok(ru.some((z) => z.value === "Europe/Moscow" && z.label === `Москва (${utcOffset("Europe/Moscow", at)})`));
    assert.match(utcOffset("Europe/Moscow", at), /^UTC\+3$/);
    const abroad = timezoneOptions("America/Argentina/Buenos_Aires", at);
    assert.equal(abroad[0].value, "America/Argentina/Buenos_Aires");
    assert.match(abroad[0].label, /^America\/Argentina\/Buenos Aires \(UTC/);
    assert.equal(utcOffset("Not/AZone", at), "");
  });
});
