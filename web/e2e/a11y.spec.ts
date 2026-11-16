import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const PAGES = ["/playground", "/embed", "/kb"];

for (const scheme of ["light", "dark"] as const) {
  for (const path of PAGES) {
    test(`axe: ${path} (${scheme}) — без serious и critical`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const { violations } = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
        .analyze();
      const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(
        bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
      ).toEqual([]);
    });
  }
}

test("/embed: лента — role=log, поле ввода в фокусе после отправки", async ({ page }) => {
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        'event: delta\ndata: {"text":"Ответ"}\n\n',
        'event: answer\ndata: {"text":"Ответ готов.","citations":[],"timings":{"server_total":1},"guard":{}}\n\n',
      ].join(""),
    }),
  );
  await page.goto("/embed");
  const input = page.getByLabel("Сообщение консультанту");
  await input.fill("Привет");
  await input.press("Enter");
  const log = page.getByRole("log");
  await expect(log).toHaveAttribute("aria-live", "polite");
  await expect(log).toHaveAttribute("aria-busy", "false");
  await expect(input).toBeFocused();
});

test("/embed: после диалога нет serious и critical", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); // иначе axe меряет контраст на середине появления сообщения
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: 'event: answer\ndata: {"text":"Ответ готов.","citations":[],"timings":{"server_total":1},"guard":{}}\n\n',
    }),
  );
  await page.goto("/embed");
  await page.getByLabel("Сообщение консультанту").fill("Привет");
  await page.getByLabel("Сообщение консультанту").press("Enter");
  await expect(page.getByText("Ответ готов.")).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    bad.map((v) => `${v.id}: ${v.nodes.map((n) => `${n.html.slice(0, 160)} ${n.any[0]?.message ?? ""}`).join(" | ")}`),
  ).toEqual([]);
});

test("виджет: Esc сворачивает чат и возвращает фокус на лаунчер", async ({ page, baseURL }) => {
  await page.setContent(`<script src="${baseURL}/widget.js" data-greeting-delay="-1"></script>`);
  const launcher = page.locator("#energytool-chat >> .launcher");
  await expect(launcher).toHaveAttribute("aria-expanded", "false");
  await launcher.click();
  await expect(launcher).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(launcher).toHaveAttribute("aria-expanded", "false");
  await expect(launcher).toBeFocused();
});

test("мобильный /embed: кнопки шапки и поля ≥ 44 px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.goto("/embed");
  for (const name of ["Связаться с менеджером", "Новый диалог", "Отправить"]) {
    const box = await page.getByRole("button", { name }).first().boundingBox();
    expect(box, name).not.toBeNull();
    expect(Math.min(box!.width, box!.height), name).toBeGreaterThanOrEqual(44);
  }
});
