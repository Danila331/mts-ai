import assert from "node:assert/strict";
import { test } from "node:test";
import {
  failMessage,
  formatKb,
  initialPreview,
  isMixedContent,
  previewReducer,
  probeStand,
  standLabel,
} from "./site-preview.ts";

test("успешный путь: probing → loading → ready", () => {
  let s = previewReducer(initialPreview, { type: "probeOk" });
  assert.equal(s.phase, "loading");
  s = previewReducer(s, { type: "loaded" });
  assert.equal(s.phase, "ready");
});

test("недоступен: probing → failed(down), повтор возвращает к проверке", () => {
  let s = previewReducer(initialPreview, { type: "probeFail", reason: "down" });
  assert.deepEqual(s, { phase: "failed", reason: "down" });
  s = previewReducer(s, { type: "retry" });
  assert.equal(s.phase, "probing");
});

test("тайм-аут загрузки: из loading и ready (перезагрузка), но не из probing/failed", () => {
  assert.equal(previewReducer({ phase: "loading", reason: null }, { type: "loadTimeout" }).reason, "timeout");
  assert.equal(previewReducer({ phase: "ready", reason: null }, { type: "loadTimeout" }).phase, "failed");
  assert.equal(previewReducer(initialPreview, { type: "loadTimeout" }), initialPreview);
  const down = { phase: "failed", reason: "down" } as const;
  assert.equal(previewReducer(down, { type: "loadTimeout" }), down);
});

test("поздние события не затирают исход", () => {
  const failed = { phase: "failed", reason: "timeout" } as const;
  assert.equal(previewReducer(failed, { type: "probeOk" }), failed);
  assert.equal(previewReducer(failed, { type: "loaded" }), failed);
  const ready = { phase: "ready", reason: null } as const;
  assert.equal(previewReducer(ready, { type: "probeFail", reason: "down" }), ready);
});

test("смешанное содержимое: https-страница и http-стенд, кроме localhost", () => {
  assert.equal(isMixedContent("https:", "http://stand.example.com:4000"), true);
  assert.equal(isMixedContent("https:", "https://stand.example.com"), false);
  assert.equal(isMixedContent("http:", "http://stand.example.com"), false);
  assert.equal(isMixedContent("https:", "http://localhost:4000"), false);
  assert.equal(isMixedContent("https:", "не адрес"), false);
});

test("probeStand: ответ — жив, ошибка сети — нет", async () => {
  assert.equal(await probeStand("http://x", 100, (async () => new Response("")) as typeof fetch), true);
  assert.equal(await probeStand("http://x", 100, (async () => { throw new TypeError("refused"); }) as typeof fetch), false);
});

test("probeStand: тайм-аут обрывает зависший запрос", async () => {
  const hang = ((_u: string, init?: RequestInit) =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;
  const t0 = Date.now();
  assert.equal(await probeStand("http://x", 50, hang), false);
  assert.ok(Date.now() - t0 < 1000);
});

test("подписи и размер", () => {
  assert.equal(standLabel(initialPreview), "проверяю…");
  assert.equal(standLabel({ phase: "ready", reason: null }), "запущена");
  assert.equal(standLabel({ phase: "failed", reason: "timeout" }), "не отвечает");
  assert.equal(standLabel({ phase: "failed", reason: "mixed" }), "нужен https");
  assert.match(failMessage("mixed"), /https/);
  assert.equal(formatKb(5018), "4,9 КБ");
  assert.equal(formatKb(2048), "2 КБ");
});
