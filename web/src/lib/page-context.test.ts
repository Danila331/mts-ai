// node --experimental-strip-types --test src/lib/*.test.ts (npm test): чистая логика страницы и темы виджета.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PAGE_MAX_BYTES, PAGE_VALUE_MAX, matchTopic, pageFrom, parseTopics, sanitizePage } from "./page-context.ts";

const topics = parseTopics('{"/solar":"solar","/askue":"askue","/askue/losses":"losses"}');

test("тема — по префиксу пути и границе сегмента", () => {
  assert.equal(matchTopic("/solar", topics), "solar");
  assert.equal(matchTopic("/solar/", topics), "solar");
  assert.equal(matchTopic("/solar/roof-plants", topics), "solar");
  assert.equal(matchTopic("/SOLAR/Roof", topics), "solar", "регистр не важен");
  assert.equal(matchTopic("/solarium", topics), undefined, "не префикс слова");
  assert.equal(matchTopic("/", topics), undefined);
  assert.equal(matchTopic("", topics), undefined);
});

test("побеждает самый длинный префикс, «/» — тема всего сайта", () => {
  assert.equal(matchTopic("/askue/losses/map", topics), "losses");
  assert.equal(matchTopic("/askue/tariffs", topics), "askue");
  const withRoot = parseTopics('{"/":"tariffs","/solar":"solar"}');
  assert.equal(matchTopic("/about", withRoot), "tariffs");
  assert.equal(matchTopic("/solar/x", withRoot), "solar");
});

test("путь с %-кодированием совпадает с префиксом кириллицей", () => {
  const ru = parseTopics('{"/солнце":"solar"}');
  assert.equal(matchTopic(encodeURI("/солнце/крыша"), ru), "solar");
  assert.equal(matchTopic("/%E0%A4%A", ru), undefined, "битая последовательность не роняет разбор");
});

test("data-topics: неверное молча пропускается", () => {
  assert.deepEqual(parseTopics(undefined), {});
  assert.deepEqual(parseTopics("не json"), {});
  assert.deepEqual(parseTopics('["/solar"]'), {});
  assert.deepEqual(
    parseTopics('{"solar":"solar","/a b":"x","/ok/":"ok","/bad":"Bad Topic","/num":1,"/q\\"":"x"}'),
    { "/ok": "ok" },
  );
});

test("страница: только путь, заголовок и UTM — остальные параметры адреса не уходят", () => {
  const page = pageFrom(
    "/solar",
    "  Солнечные   станции ",
    "?utm_source=yandex&utm_medium=cpc&gclid=abc&email=a@b.ru&utm_term=&utm_campaign=sun",
  );
  assert.deepEqual(page, { path: "/solar", title: "Солнечные станции", utm_source: "yandex", utm_medium: "cpc", utm_campaign: "sun" });
});

test("страница: лишние ключи и не строки отбрасываются, значения обрезаются", () => {
  assert.deepEqual(sanitizePage({ path: "/x", cookie: "sid=1", referrer: "https://ya.ru", title: 5 }), { path: "/x" });
  assert.deepEqual(sanitizePage(null), {});
  assert.deepEqual(sanitizePage(["/x"]), {});
  const long = sanitizePage({ title: "я".repeat(PAGE_VALUE_MAX + 50) });
  assert.equal(Array.from(long.title!).length, PAGE_VALUE_MAX);
});

test("страница не больше предела сервера даже из длинной кириллицы", () => {
  const huge = "я".repeat(1000);
  const page = sanitizePage({
    path: `/${huge}`,
    title: huge,
    utm_source: huge,
    utm_medium: huge,
    utm_campaign: huge,
    utm_term: huge,
    utm_content: huge,
  });
  assert.ok(new TextEncoder().encode(JSON.stringify(page)).length <= PAGE_MAX_BYTES);
  assert.ok(page.path, "путь — самое важное, он остаётся");
});
