// node --experimental-strip-types --test (npm test): кому верим в X-Forwarded-For (T35).
import assert from "node:assert/strict";
import { test } from "node:test";
import { clientIpFrom, firstAddress, trustProxyHeaders } from "./client-ip.ts";

const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;

test("по умолчанию доверяем только Vercel", () => {
  assert.equal(trustProxyHeaders({}), false);
  assert.equal(trustProxyHeaders({ VERCEL: "1" }), true);
});

test("EB_TRUST_PROXY_HEADERS главнее платформы", () => {
  for (const v of ["1", "true", "YES", " on "]) assert.equal(trustProxyHeaders({ EB_TRUST_PROXY_HEADERS: v }), true, v);
  for (const v of ["0", "false", "no", "off"]) assert.equal(trustProxyHeaders({ EB_TRUST_PROXY_HEADERS: v, VERCEL: "1" }), false, v);
  assert.equal(trustProxyHeaders({ EB_TRUST_PROXY_HEADERS: "maybe" }), false, "непонятное значение — как не задано");
});

test("без доверия заголовок клиента игнорируется: подделка не меняет адрес", () => {
  const get = headers({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7" });
  assert.equal(clientIpFrom(get, {}), "");
  assert.equal(clientIpFrom(get, { EB_TRUST_PROXY_HEADERS: "0", VERCEL: "1" }), "");
});

test("с доверием берётся первый адрес цепочки", () => {
  const env = { EB_TRUST_PROXY_HEADERS: "1" };
  assert.equal(clientIpFrom(headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }), env), "203.0.113.7");
  assert.equal(clientIpFrom(headers({ "x-real-ip": "203.0.113.8" }), env), "203.0.113.8");
  assert.equal(clientIpFrom(headers({}), env), "");
});

test("мусор вместо адреса отбрасывается", () => {
  assert.equal(firstAddress("<script>alert(1)</script>"), "");
  assert.equal(firstAddress("1.2.3"), "");
  assert.equal(firstAddress(""), "");
  assert.equal(firstAddress(null), "");
  assert.equal(firstAddress("2001:db8::1, 10.0.0.1"), "2001:db8::1");
  assert.equal(clientIpFrom(headers({ "x-forwarded-for": "evil\nX-Admin: 1", "x-real-ip": "203.0.113.9" }), { VERCEL: "1" }), "203.0.113.9");
});
