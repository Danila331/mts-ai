// node --experimental-strip-types --test (npm test): кому верить в postMessage и кто может встроить /embed (T35).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  embedFrameAncestors,
  isLocalOrigin,
  isTrustedMessage,
  parseOrigins,
  resolveParent,
  targetOrigin,
  toOrigin,
} from "./embed-origin.ts";

const SELF = "https://chat.example";
const SITE = "https://www.partner.ru";

test("allowlist: только origin'ы без путей и масок, без повторов", () => {
  assert.deepEqual(parseOrigins("https://a.ru, https://b.ru:8443 https://a.ru"), ["https://a.ru", "https://b.ru:8443"]);
  assert.deepEqual(parseOrigins("https://a.ru/"), ["https://a.ru"], "слэш в конце — тот же origin");
  assert.deepEqual(parseOrigins("https://a.ru/path"), [], "путь — не origin");
  assert.deepEqual(parseOrigins("https://*.a.ru, *, http://*"), [], "маски не поддерживаются");
  assert.deepEqual(parseOrigins("javascript:alert(1), ftp://a.ru, мусор, null"), []);
  assert.deepEqual(parseOrigins("https://user:pw@a.ru"), []);
  assert.deepEqual(parseOrigins(""), []);
  assert.deepEqual(parseOrigins(undefined), []);
  assert.equal(toOrigin("HTTPS://A.RU"), "https://a.ru");
});

test("frame-ancestors /embed: свой origin и allowlist; пустой — только локальные стенды, не «любой»", () => {
  const withList = embedFrameAncestors(["https://a.ru", "https://b.ru"]);
  assert.equal(withList, "frame-ancestors 'self' https://a.ru https://b.ru");
  assert.ok(!withList.includes("localhost"), "в боевом списке локальных стендов нет");

  const empty = embedFrameAncestors([]);
  assert.ok(empty.startsWith("frame-ancestors 'self' "));
  assert.ok(empty.includes("http://localhost:*") && empty.includes("http://127.0.0.1:*"));
  assert.ok(!/(^|\s)\*(\s|$)/.test(empty) && !empty.includes("https:"), "никакого «*» и «https:»");
});

test("локальные стенды", () => {
  for (const o of ["http://localhost:3000", "http://127.0.0.1:8080", "http://[::1]:3000", "http://demo.localhost:3000"]) {
    assert.ok(isLocalOrigin(o), o);
  }
  for (const o of ["https://localhost.evil.ru", "https://evil.ru", "http://127.0.0.1.evil.ru", "мусор"]) {
    assert.ok(!isLocalOrigin(o), o);
  }
});

test("?parent=: чужой origin не принимается, если его нет в allowlist", () => {
  assert.equal(resolveParent(SITE, [SITE], null, SELF), SITE);
  assert.equal(resolveParent("https://evil.ru", [SITE], null, SELF), null, "нет в allowlist");
  assert.equal(resolveParent("https://evil.ru", [SITE], "https://evil.ru", SELF), null, "и настоящий хозяин не из списка");
  assert.equal(resolveParent("*", [SITE], null, SELF), null);
  assert.equal(resolveParent("null", [SITE], null, SELF), null);
  assert.equal(resolveParent("https://www.partner.ru/page?x=1", [SITE], null, SELF), null, "не origin");
  assert.equal(resolveParent(null, [SITE], null, SELF), null);
  assert.equal(resolveParent(SELF, [SITE], null, SELF), SELF, "свой origin — всегда (демо-страница стенда)");
});

test("?parent=: настоящий хозяин окна главнее параметра", () => {
  // Хозяин из allowlist, но окно встроено другим сайтом: параметр подделан.
  assert.equal(resolveParent(SITE, [SITE, "https://other.ru"], "https://other.ru", SELF), null);
  assert.equal(resolveParent(SITE, [SITE], SITE, SELF), SITE, "совпал — доверяем");
  assert.equal(resolveParent(SITE, [SITE], "null", SELF), SITE, "ancestorOrigins недоступен — полагаемся на allowlist");
  assert.equal(resolveParent(SITE, [SITE], undefined, SELF), SITE, "Firefox: ancestorOrigins нет");
});

test("?parent= при пустом allowlist: только свой origin и локальные стенды", () => {
  assert.equal(resolveParent("http://localhost:3000", [], null, SELF), "http://localhost:3000");
  assert.equal(resolveParent(SELF, [], null, SELF), SELF);
  assert.equal(resolveParent(SITE, [], null, SELF), null, "боевой сайт без allowlist не получает чат");
  assert.equal(resolveParent(SITE, [], SITE, SELF), null);
});

test("postMessage: чужой origin игнорируется", () => {
  const parentWindow = {};
  const iframeWindow = {};
  assert.ok(isTrustedMessage({ origin: SITE, source: parentWindow }, SITE, parentWindow));
  assert.ok(!isTrustedMessage({ origin: "https://evil.ru", source: parentWindow }, SITE, parentWindow), "чужой origin");
  assert.ok(!isTrustedMessage({ origin: SITE, source: iframeWindow }, SITE, parentWindow), "тот же origin, другое окно");
  assert.ok(!isTrustedMessage({ origin: SITE, source: null }, SITE, parentWindow), "нет источника");
  assert.ok(!isTrustedMessage({ origin: SITE, source: parentWindow }, SITE, null), "нет ожидаемого окна");
  assert.ok(!isTrustedMessage({ origin: SITE, source: parentWindow }, null, parentWindow), "хозяин не доверенный");
  assert.ok(!isTrustedMessage({ origin: "*", source: parentWindow }, "*", parentWindow), "«*» не origin");
  assert.ok(!isTrustedMessage({ origin: "null", source: parentWindow }, "null", parentWindow), "opaque origin");
  assert.ok(!isTrustedMessage({ origin: `${SITE}.evil.ru`, source: parentWindow }, SITE, parentWindow), "не префикс");
});

test("targetOrigin: точный origin, никогда «*»", () => {
  assert.equal(targetOrigin(SITE), SITE);
  assert.equal(targetOrigin("*"), null);
  assert.equal(targetOrigin("null"), null);
  assert.equal(targetOrigin(""), null);
  assert.equal(targetOrigin(null), null);
  assert.equal(targetOrigin("https://a.ru/path"), null);
});
