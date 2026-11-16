// node --experimental-strip-types --test (npm test): ссылки в ответе — только /kb и allowlist (T35).
import assert from "node:assert/strict";
import { test } from "node:test";
import { HIDDEN_LINK, isAllowedLink, safeAnswerText } from "./answer-links.ts";

test("обычный ответ не меняется", () => {
  const text = "Да, платформа собирает показания. Порог 750 кВт, срок 10.5 дня. Уточните регион?";
  assert.equal(safeAnswerText(text), text);
});

test("ссылки только на /kb и allowlist", () => {
  assert.ok(isAllowedLink("/kb"));
  assert.ok(isAllowedLink("/kb/askue"));
  assert.ok(isAllowedLink("/kb?chunk=1#x"));
  assert.ok(!isAllowedLink("/kbx"));
  assert.ok(!isAllowedLink("//evil.ru/kb"));
  assert.ok(!isAllowedLink("https://evil.ru/kb"));
  assert.ok(!isAllowedLink("javascript:alert(1)"));
  assert.ok(isAllowedLink("https://docs.mts.ru/a", ["mts.ru"]));
  assert.ok(!isAllowedLink("https://notmts.ru/a", ["mts.ru"]));
  assert.ok(!isAllowedLink("https://mts.ru.evil.ru/a", ["mts.ru"]));
});

test("чужие адреса и схемы скрываются", () => {
  assert.equal(safeAnswerText("Смотрите https://evil.ru/pay сейчас"), `Смотрите ${HIDDEN_LINK} сейчас`);
  assert.equal(safeAnswerText("Откройте www.evil.ru"), `Откройте ${HIDDEN_LINK}`);
  assert.equal(safeAnswerText("javascript:alert(1)"), HIDDEN_LINK);
  assert.equal(safeAnswerText("https://docs.mts.ru/x", ["mts.ru"]), "https://docs.mts.ru/x");
});

test("Markdown-ссылка сводится к подписи, адрес не прячется за текстом", () => {
  assert.equal(safeAnswerText("Раздел [Тарифы](https://evil.ru/login) базы"), "Раздел Тарифы базы");
  assert.equal(safeAnswerText("![картинка](https://evil.ru/x.png)"), "картинка");
  assert.equal(safeAnswerText("[](/kb/askue)"), "/kb/askue");
});

test("HTML остаётся текстом (экранирует React), ссылка в нём скрыта", () => {
  assert.equal(safeAnswerText('<a href="https://evil.ru">x</a>'), `<a href="${HIDDEN_LINK}">x</a>`);
  assert.equal(safeAnswerText("<script>alert(1)</script>"), "<script>alert(1)</script>");
});
