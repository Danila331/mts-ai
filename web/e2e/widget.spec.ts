import { expect, test, type Page } from "@playwright/test";

// Виджет на странице-заглушке превью: подсказка у кнопки, быстрые вопросы и сама кнопка должны открывать чат.
const PREVIEW = "/widget-preview.html?greetingDelay=0&quick=" + encodeURIComponent("Первый вопрос|Второй вопрос");

async function bubbleShown(page: Page) {
  const bubble = page.locator("#energytool-chat .bubble");
  await expect(bubble).toHaveClass(/show/);
  return bubble;
}

const panelOpen = (page: Page) => expect(page.locator("#energytool-chat .wrap")).toHaveClass(/open/);

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

for (const [name, pick] of [
  ["текст приветствия", (p: Page) => p.locator("#energytool-chat .bubble .text")],
  ["заголовок подсказки", (p: Page) => p.locator("#energytool-chat .bubble .head b")],
  ["аватар подсказки", (p: Page) => p.locator("#energytool-chat .bubble .ava")],
  ["край подсказки", (p: Page) => p.locator("#energytool-chat .bubble")],
] as const) {
  test(`виджет: клик по подсказке (${name}) открывает чат`, async ({ page }) => {
    await page.goto(PREVIEW);
    await bubbleShown(page);
    await pick(page).click({ position: name === "край подсказки" ? { x: 4, y: 4 } : undefined });
    await panelOpen(page);
    await expect(page.locator("#energytool-chat iframe")).toHaveCount(1);
  });
}

test("виджет: быстрый вопрос открывает чат и задаёт вопрос", async ({ page }) => {
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: 'event: answer\ndata: {"text":"Ответ готов.","citations":[],"timings":{"server_total":1},"guard":{}}\n\n',
    }),
  );
  await page.goto(PREVIEW);
  await bubbleShown(page);
  await page.locator("#energytool-chat .bubble .quick button", { hasText: "Второй вопрос" }).click();
  await panelOpen(page);
  const chat = page.frameLocator("#energytool-chat iframe");
  await expect(chat.getByText("Второй вопрос").first()).toBeVisible();
});

test("виджет: кнопка-launcher открывает и закрывает чат", async ({ page }) => {
  await page.goto(PREVIEW);
  await bubbleShown(page);
  const launcher = page.locator("#energytool-chat .launcher");
  await launcher.click();
  await panelOpen(page);
  await launcher.click();
  await expect(page.locator("#energytool-chat .wrap")).not.toHaveClass(/open/);
});

test("виджет: sessionStorage недоступен (чужой iframe) — подсказка видна, чат открывается и задаёт вопрос", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "sessionStorage", {
      get() {
        throw new DOMException("Access is denied for this document.", "SecurityError");
      },
    });
  });
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: 'event: answer\ndata: {"text":"Ответ готов.","citations":[],"timings":{"server_total":1},"guard":{}}\n\n',
    }),
  );
  await page.goto(PREVIEW);
  await bubbleShown(page);
  await page.locator("#energytool-chat .bubble .quick button", { hasText: "Первый вопрос" }).click();
  await panelOpen(page);
  await expect(page.frameLocator("#energytool-chat iframe").getByText("Первый вопрос").first()).toBeVisible();
});

test("/widget: страницы превью — реальные страницы сайта МТС (/askue, /orem), без /solar", async ({ page }) => {
  await page.goto("/widget");
  const pages = page.getByRole("radiogroup", { name: "Страница сайта в превью" });
  await expect(pages.getByText("/askue", { exact: true })).toBeVisible();
  await expect(pages.getByText("/orem", { exact: true })).toBeVisible();
  await expect(pages.getByText("/solar", { exact: true })).toHaveCount(0);
  await expect(page.getByText("/solar", { exact: false })).toHaveCount(0);
});

// Копия сайта МТС грузит карты и видео — её load приходит поздно или не приходит. Превью должно считать её готовой по
// сообщению stand.js, и тогда кнопки «Спросить в превью» доходят до страницы.
test("/widget: превью сайта МТС готово по сообщению stand.js, кнопки «Спросить в превью» работают без load", async ({ page }) => {
  await page.route("http://localhost:4000/**", (route) => {
    if (route.request().url().includes("/hang.png")) return; // запрос «висит» — load не наступит
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><title>stand</title><img src="/hang.png"><script>
        addEventListener("message", function (e) { if (e.data && e.data.type === "eb:preview") parent.postMessage({ type: "got", action: e.data.action, text: e.data.text }, "*"); });
        parent.postMessage({ type: "eb:preview-ready" }, "*");
      </script>`,
    });
  });
  await page.addInitScript(() => {
    (window as unknown as { got: unknown[] }).got = [];
    addEventListener("message", (e) => {
      if (e.data?.type === "got") (window as unknown as { got: unknown[] }).got.push(e.data);
    });
  });
  await page.goto("/widget");
  await expect(page.locator('iframe[title^="Превью: сайт МТС"]')).toBeVisible();
  await expect(page.getByText("Загружаю копию сайта МТС…")).toBeHidden({ timeout: 10_000 });
  await page.getByRole("button", { name: "Открыть / закрыть чат" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { got: { action: string }[] }).got.map((m) => m.action))).toEqual(["toggle"]);
  await page.getByRole("button", { name: "Солнечные панели" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { got: { action: string }[] }).got.length)).toBe(2);
});

test("виджет: наведение начинает грузить чат до клика; до eb:ready — индикатор, а не белое окно", async ({ page }) => {
  // Задерживаем страницу чата, чтобы поймать состояние «грузится».
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/embed?**", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto(PREVIEW);
  await bubbleShown(page);
  const launcher = page.locator("#energytool-chat .launcher");
  await launcher.hover();
  await expect(page.locator("#energytool-chat iframe")).toHaveCount(1); // создан по наведению, до клика
  await expect(page.locator("#energytool-chat .wrap")).not.toHaveClass(/open/);
  await launcher.click();
  await panelOpen(page);
  const panel = page.locator("#energytool-chat .panel");
  await expect(page.locator("#energytool-chat .loading")).toBeVisible();
  await expect(panel).not.toHaveClass(/ready/);
  release();
  await expect(panel).toHaveClass(/ready/, { timeout: 30_000 }); // eb:ready от чата
  await expect(page.locator("#energytool-chat .loading")).toBeHidden();
  await expect(page.frameLocator("#energytool-chat iframe").locator("textarea")).toBeVisible();
});

