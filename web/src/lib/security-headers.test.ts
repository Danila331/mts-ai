// node --experimental-strip-types --test (npm test): заголовки frame-ancestors и постоянные заголовки (T35).
import assert from "node:assert/strict";
import { test } from "node:test";
import { STATIC_HEADERS, framePolicy, isEmbedPath, pageHeaders } from "./security-headers.ts";

test("/embed встраивается только с allowlist; чужой origin в политике не появляется", () => {
  const policy = framePolicy("/embed", "https://www.partner.ru, https://shop.partner.ru");
  assert.equal(policy, "frame-ancestors 'self' https://www.partner.ru https://shop.partner.ru");
  assert.ok(!policy.includes("evil.ru"));
  assert.ok(!policy.includes("*"));
  assert.ok(!policy.includes("localhost"));
});

test("/embed без allowlist: свой origin и локальные стенды, не любой сайт", () => {
  for (const raw of [undefined, "", "   ", "мусор, *, https://*.a.ru"]) {
    const policy = framePolicy("/embed", raw);
    assert.ok(policy.startsWith("frame-ancestors 'self' http://localhost:*"), String(raw));
    assert.ok(!policy.includes("https:"), String(raw));
  }
});

test("остальные страницы не встраивает никто", () => {
  for (const path of ["/", "/settings", "/kb", "/manager", "/embedded", "/widget", "/embed-x"]) {
    assert.equal(framePolicy(path, "https://www.partner.ru"), "frame-ancestors 'none'", path);
    assert.equal(pageHeaders(path, "https://www.partner.ru")["X-Frame-Options"], "DENY", path);
  }
});

test("пути /embed", () => {
  assert.ok(isEmbedPath("/embed") && isEmbedPath("/embed/"));
  assert.ok(!isEmbedPath("/embedded") && !isEmbedPath("/x/embed"));
  assert.equal(pageHeaders("/embed", "https://a.ru")["X-Frame-Options"], undefined, "XFO DENY запретил бы и разрешённых");
});

test("постоянные заголовки", () => {
  const map = Object.fromEntries(STATIC_HEADERS.map((h) => [h.key, h.value]));
  assert.equal(map["X-Content-Type-Options"], "nosniff");
  assert.equal(map["Referrer-Policy"], "strict-origin-when-cross-origin");
});
