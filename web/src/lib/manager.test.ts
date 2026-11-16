// node --experimental-strip-types --test src/lib/*.test.ts  (npm test)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  DIALOG_ID,
  STATUS_LABEL,
  ago,
  channelLabel,
  dialogRole,
  dialogTitle,
  filledFields,
  formatPhone,
  latestDialogsFirst,
  leadTitle,
  messagesLabel,
  newCodes,
  newestFirst,
  pickTranscript,
  waiting,
} from "./manager.ts";

describe("T5: список заявок менеджера", () => {
  test("первая загрузка ничего не подсвечивает, дальше — только новые номера", () => {
    const items = [{ code: "a1" }, { code: "b2" }];
    assert.deepEqual(newCodes(null, items), []);
    assert.deepEqual(newCodes(new Set(["a1", "b2"]), items), []);
    assert.deepEqual(newCodes(new Set(["a1"]), [{ code: "c3" }, ...items]), ["c3", "b2"]);
  });

  test("новые сверху", () => {
    const sorted = newestFirst([
      { code: "old", created_at: "2026-11-16T10:00:00Z" },
      { code: "new", created_at: "2026-11-16T12:00:00Z" },
    ]);
    assert.deepEqual(sorted.map((i) => i.code), ["new", "old"]);
  });

  test("«сколько назад»", () => {
    const now = Date.parse("2026-11-16T12:00:00Z");
    assert.equal(ago("2026-11-16T11:59:50Z", now), "только что");
    assert.equal(ago("2026-11-16T11:55:00Z", now), "5 мин назад");
    assert.equal(ago("2026-11-16T09:00:00Z", now), "3 ч назад");
    assert.equal(ago("2026-11-14T12:00:00Z", now), "2 дн назад");
  });

  test("«ждёт N»", () => {
    const now = Date.parse("2026-11-16T12:00:00Z");
    assert.equal(waiting("2026-11-16T11:59:50Z", now), "ждёт меньше минуты");
    assert.equal(waiting("2026-11-16T11:55:00Z", now), "ждёт 5 мин");
  });

  test("четыре статуса и заголовок без компании", () => {
    assert.deepEqual(Object.keys(STATUS_LABEL), ["new", "in_progress", "done", "rejected"]);
    assert.equal(leadTitle({ company: "", name: "Тестов Тест Тестович" }), "Тестов Тест Тестович");
    assert.equal(leadTitle({ company: "", name: "" }), "Без названия");
  });

  test("статусы и подписи те же, что на сервере (lead.Statuses)", () => {
    const go = readFileSync(new URL("../../../backend/internal/lead/status.go", import.meta.url), "utf8");
    const server = [...go.matchAll(/\{Status(\w+), "([^"]+)"\}/g)].map((m) => [
      m[1].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(),
      m[2],
    ]);
    assert.deepEqual(server, Object.entries(STATUS_LABEL));
  });
});

describe("телефон и время в карточке менеджера", () => {
  test("российский номер — в виде +7 900 000-00-00", () => {
    assert.equal(formatPhone("+79000000000"), "+7 900 000-00-00");
    assert.equal(formatPhone("8 (900) 123-45-67"), "+7 900 123-45-67");
    assert.equal(formatPhone("9001234567"), "+7 900 123-45-67");
  });
  test("чужой формат и пустое значение не портим", () => {
    assert.equal(formatPhone("+375291234567"), "+375291234567");
    assert.equal(formatPhone(""), "");
  });
});

describe("вкладка «Диалоги»", () => {
  test("последние сверху, заголовок и канал", () => {
    const sorted = latestDialogsFirst([
      { id: "a", updated_at: "2026-11-16T10:00:00Z" },
      { id: "b", updated_at: "2026-11-16T12:00:00Z" },
    ]);
    assert.deepEqual(sorted.map((d) => d.id), ["b", "a"]);
    assert.equal(dialogTitle({ title: "  " }), "Без названия");
    assert.equal(dialogTitle({ title: "Что такое АСКУЭ?" }), "Что такое АСКУЭ?");
    assert.equal(channelLabel("embed"), "виджет");
    assert.equal(channelLabel("playground"), "стенд");
    assert.equal(channelLabel("fax"), "fax");
  });

  test("число реплик по-русски", () => {
    assert.deepEqual([0, 1, 2, 4, 5, 11, 12, 21, 22, 25, 111].map(messagesLabel), [
      "0 реплик", "1 реплика", "2 реплики", "4 реплики", "5 реплик", "11 реплик", "12 реплик", "21 реплика",
      "22 реплики", "25 реплик", "111 реплик",
    ]);
  });

  test("роль собеседника: известная — подпись, остальное — пусто", () => {
    assert.equal(dialogRole("business"), "Бизнес");
    assert.equal(dialogRole(""), "");
    assert.equal(dialogRole("hacker"), "");
    assert.equal(dialogRole(undefined), "");
  });

  test("id диалога в прокси — как в Go-API", () => {
    assert.ok(DIALOG_ID.test("widget-sess-1"));
    assert.ok(DIALOG_ID.test("a".repeat(64)));
    for (const bad of ["short", "a".repeat(65), "../../etc/passwd", "sess id 123", "sess/1234567"]) {
      assert.equal(DIALOG_ID.test(bad), false, bad);
    }
  });
});

describe("карточка заявки: всё, что собрано в чате", () => {
  const field = (key: string, group: string, value?: string) => ({ key, label: key, group, value }) as never;

  test("паспорт показывает контакты и удобное время, пустые поля — нет", () => {
    const rows = filledFields({
      fields: [
        field("name", "contacts", "Тестов Тест"),
        field("phone", "contacts", "+7 900 000-00-00"),
        field("callback_preference", "contacts", "завтра после 14:00"),
        field("region", "general", "Тверская область"),
        field("company", "contacts", "  "),
        field("power", "general"),
      ],
    });
    assert.deepEqual(rows.map((r) => r.key), ["name", "phone", "callback_preference", "region"]);
    assert.deepEqual(filledFields(null), []);
    assert.deepEqual(filledFields({}), []);
  });

  test("переписка: полная с сервера главнее, заявочная — когда сессии нет или в ней меньше", () => {
    const full = [
      { role: "assistant" as const, content: "Здравствуйте!", at: "t" },
      { role: "user" as const, content: "Привет", at: "t" },
      { role: "assistant" as const, content: "Чем помочь?", at: "t" },
    ];
    const sent = [
      { role: "user", content: "Привет" },
      { role: "assistant", content: "Чем помочь?" },
    ];
    assert.equal(pickTranscript({ turns: full }, sent, "sent"), full);
    const fromLead = pickTranscript(null, sent, "sent");
    assert.deepEqual(fromLead.map((t) => [t.role, t.content, t.at]), [
      ["user", "Привет", "sent"],
      ["assistant", "Чем помочь?", "sent"],
    ]);
    // Сессия старше хранения переписки: в ней одна пара, в заявке больше.
    const sparse = [{ role: "user" as const, content: "Привет", at: "t" }];
    assert.equal(pickTranscript({ turns: sparse }, sent, "sent").length, 2);
    assert.deepEqual(pickTranscript(null, undefined, "sent"), []);
  });
});
