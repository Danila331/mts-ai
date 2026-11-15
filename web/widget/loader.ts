/**
 * Загрузчик виджета ИИ-консультанта МТС EnergyTool. Собирается в public/widget.js (npm run build:widget).
 *
 *   <script src="https://<хост>/widget.js" async data-title="…" data-color="#FF0032" data-position="right"
 *           data-greeting="…" data-greeting-delay="6"></script>
 *
 * Кнопка и подсказка живут в Shadow DOM (стили сайта их не ломают и наоборот), чат — в iframe на /embed.
 * Связь с iframe — postMessage с проверкой origin. API страницы: window.EnergyToolChat.{open, close, toggle, ask, destroy}.
 * Любой элемент с data-energytool-ask="вопрос" открывает виджет с этим вопросом.
 */

interface Config {
  title: string;
  subtitle: string;
  color: string;
  position: "left" | "right";
  greeting: string;
  greetingDelay: number;
  offsetX: number;
  offsetY: number;
  open: boolean;
  /** Быстрые вопросы в подсказке: data-quick="вопрос 1|вопрос 2", data-quick="" — без них. */
  quick: string[];
}

interface Api {
  open(): void;
  close(): void;
  toggle(): void;
  ask(question: string): void;
  destroy(): void;
  readonly isOpen: boolean;
  readonly version: string;
}

declare global {
  interface Window {
    EnergyToolChat?: Api;
  }
}

const VERSION = "1.0.0";
const STORAGE_OPEN = "energytool-chat:open";
const STORAGE_GREETED = "energytool-chat:greeted";

(function init() {
  if (window.EnergyToolChat) return;
  const script =
    (document.currentScript as HTMLScriptElement | null) ??
    document.querySelector<HTMLScriptElement>('script[src*="widget.js"][data-energytool], script[src*="/widget.js"]');
  if (!script) return;

  const origin = new URL(script.src, location.href).origin;
  const d = script.dataset;
  const hex = /^#[0-9a-f]{3,8}$/i;
  const cfg: Config = {
    title: d.title || "Консультант EnergyTool",
    subtitle: d.subtitle || "Отвечает по базе знаний МТС",
    color: d.color && hex.test(d.color) ? d.color : "#FF0032",
    position: d.position === "left" ? "left" : "right",
    greeting: d.greeting ?? "Здравствуйте! Подберу решение по энергоучёту, потерям и солнечной генерации.",
    greetingDelay: Number(d.greetingDelay ?? 6),
    offsetX: Number(d.offsetX ?? 24),
    offsetY: Number(d.offsetY ?? 24),
    open: d.open === "true",
    quick: (d.quick ?? "Как снизить расходы на электроэнергию?|Окупится ли солнечная станция?")
      .split("|")
      .map((q) => q.trim())
      .filter(Boolean)
      .slice(0, 3),
  };

  const side = cfg.position;
  const host = document.createElement("div");
  host.id = "energytool-chat";
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483000;";
  const root = host.attachShadow({ mode: "open" });

  const font = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  root.innerHTML = `
<style>
  :host { --c: ${cfg.color}; }
  * { box-sizing: border-box; }
  .launcher {
    position: fixed; bottom: ${cfg.offsetY}px; ${side}: ${cfg.offsetX}px;
    width: 56px; height: 56px; border-radius: 50%; border: 0; cursor: pointer; padding: 0;
    background: var(--c); color: #fff; display: grid; place-items: center;
    box-shadow: 0 1px 2px rgba(0,0,0,.12), 0 8px 24px -6px rgba(0,0,0,.28);
    transition: transform .25s cubic-bezier(.16,1,.3,1), box-shadow .25s ease;
  }
  .launcher:hover { transform: translateY(-2px); box-shadow: 0 2px 4px rgba(0,0,0,.14), 0 12px 32px -6px rgba(0,0,0,.32); }
  .launcher:active { transform: translateY(0) scale(.97); }
  .launcher:focus-visible { outline: 3px solid color-mix(in srgb, var(--c) 35%, white); outline-offset: 3px; }
  .launcher svg { width: 26px; height: 26px; transition: transform .3s cubic-bezier(.16,1,.3,1), opacity .2s ease; position: absolute; }
  .launcher .i-close { width: 22px; height: 22px; transform: rotate(-90deg) scale(.6); opacity: 0; }
  .open .launcher .i-chat { transform: rotate(90deg) scale(.6); opacity: 0; }
  .open .launcher .i-close { transform: none; opacity: 1; }
  .badge {
    position: absolute; top: 1px; ${side === "right" ? "right" : "left"}: 1px; width: 14px; height: 14px;
    border-radius: 50%; background: #1b1c1e; border: 2.5px solid #fff; display: none;
  }
  .unread .badge { display: block; }
  .bubble {
    position: fixed; bottom: ${cfg.offsetY + 70}px; ${side}: ${cfg.offsetX}px; width: 304px;
    background: #fff; color: #1b1c1e; border-radius: 16px; border-${side === "right" ? "bottom-right" : "bottom-left"}-radius: 4px;
    padding: 14px; font: 14px/1.45 ${font}; -webkit-font-smoothing: antialiased;
    box-shadow: 0 0 0 1px rgba(0,0,0,.07), 0 4px 8px -2px rgba(0,0,0,.06), 0 16px 40px -8px rgba(0,0,0,.18); cursor: pointer;
    opacity: 0; transform: translateY(8px) scale(.98); transform-origin: bottom ${side};
    pointer-events: none; transition: opacity .3s ease, transform .35s cubic-bezier(.16,1,.3,1);
  }
  .bubble.show { opacity: 1; transform: none; pointer-events: auto; }
  .bubble .head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; padding-right: 22px; }
  .bubble .ava { width: 28px; height: 28px; border-radius: 8px; background: var(--c); color: #fff; display: grid; place-items: center; flex: none; }
  .bubble .ava svg { width: 21px; height: 21px; }
  .bubble b { display: block; font-size: 13px; color: #1b1c1e; font-weight: 600; line-height: 1.25; }
  .bubble .st { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #66696f; margin-top: 1px; }
  .bubble .st i { width: 6px; height: 6px; border-radius: 50%; background: #15803d; }
  .bubble .text { display: block; }
  .bubble .quick { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
  .bubble .quick button { all: unset; box-sizing: border-box; cursor: pointer; padding: 8px 11px; border-radius: 10px;
    border: 1px solid #e7e7ea; color: #1b1c1e; font: 500 13px/1.3 ${font}; transition: background .15s, border-color .15s; }
  .bubble .quick button:hover { background: #f8f8f9; border-color: #dadbdf; }
  .bubble .quick button:focus-visible { outline: 2px solid color-mix(in srgb, var(--c) 45%, white); outline-offset: 1px; }
  .bubble .x { position: absolute; top: 8px; right: 8px; width: 24px; height: 24px; border: 0; padding: 0; background: none;
    color: #8e9198; cursor: pointer; border-radius: 6px; display: grid; place-items: center; }
  .bubble .x svg { width: 14px; height: 14px; }
  .bubble .x:hover { background: #f2f2f4; color: #1b1c1e; }
  .panel {
    position: fixed; bottom: ${cfg.offsetY + 72}px; ${side}: ${cfg.offsetX}px;
    width: 400px; height: min(680px, calc(100vh - ${cfg.offsetY + 96}px));
    border-radius: 16px; overflow: hidden; background: #fff;
    box-shadow: 0 0 0 1px rgba(0,0,0,.07), 0 6px 12px -4px rgba(0,0,0,.08), 0 24px 56px -12px rgba(0,0,0,.28);
    opacity: 0; transform: translateY(12px) scale(.98); transform-origin: bottom ${side};
    pointer-events: none; visibility: hidden;
    transition: opacity .2s ease, transform .3s cubic-bezier(.16,1,.3,1), visibility 0s linear .3s;
  }
  .open .panel { opacity: 1; transform: none; pointer-events: auto; visibility: visible; transition-delay: 0s; }
  iframe { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
  .loading { position: absolute; inset: 0; display: grid; place-items: center; color: #66696f; font: 13px ${font}; }
  @media (max-width: 640px) {
    .panel { inset: 0; width: 100%; height: 100%; border-radius: 0; bottom: 0; ${side}: 0; }
    .open .launcher { display: none; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
<div class="wrap">
  <div class="panel" role="dialog" aria-label="${escapeHtml(cfg.title)}" aria-modal="false">
    <div class="loading">Загружаю консультанта…</div>
  </div>
  <div class="bubble" role="status">
    <div class="head">
      <span class="ava"><svg viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="M7.42 19.39A7 7 0 1 1 20.58 19.39" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M14 17 17.6 12.7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="14" cy="17" r="1.7" fill="currentColor"/></svg></span>
      <span><b>${escapeHtml(cfg.title)}</b><span class="st"><i></i>${escapeHtml(cfg.subtitle)}</span></span>
    </div>
    <span class="text">${escapeHtml(cfg.greeting)}</span>
    ${cfg.quick.length ? `<div class="quick">${cfg.quick.map((q) => `<button type="button" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join("")}</div>` : ""}
    <button class="x" aria-label="Скрыть подсказку"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
  </div>
  <button class="launcher" aria-label="Открыть чат с консультантом" aria-expanded="false">
    <svg class="i-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M8 12h.01M12 12h.01M16 12h.01" stroke-width="2.6"/></svg>
    <svg class="i-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
    <span class="badge"></span>
  </button>
</div>`;

  const wrap = root.querySelector<HTMLDivElement>(".wrap")!;
  const panel = root.querySelector<HTMLDivElement>(".panel")!;
  const bubble = root.querySelector<HTMLDivElement>(".bubble")!;
  const launcher = root.querySelector<HTMLButtonElement>(".launcher")!;

  let iframe: HTMLIFrameElement | null = null;
  let ready = false;
  let isOpen = false;
  const queue: unknown[] = [];

  const embedUrl = () => {
    const u = new URL("/embed", origin);
    u.searchParams.set("title", cfg.title);
    u.searchParams.set("subtitle", cfg.subtitle);
    u.searchParams.set("color", cfg.color);
    if (cfg.greeting) u.searchParams.set("greeting", cfg.greeting);
    u.searchParams.set("parent", location.origin);
    return u.toString();
  };

  function ensureFrame() {
    if (iframe) return;
    iframe = document.createElement("iframe");
    iframe.title = cfg.title;
    iframe.src = embedUrl();
    iframe.allow = "clipboard-write";
    iframe.addEventListener("load", () => root.querySelector(".loading")?.remove());
    panel.appendChild(iframe);
  }

  function post(msg: unknown) {
    if (ready && iframe?.contentWindow) iframe.contentWindow.postMessage(msg, origin);
    else queue.push(msg);
  }

  function hideBubble() {
    bubble.classList.remove("show");
  }

  function open() {
    ensureFrame();
    isOpen = true;
    hideBubble();
    wrap.classList.add("open");
    wrap.classList.remove("unread");
    launcher.setAttribute("aria-expanded", "true");
    launcher.setAttribute("aria-label", "Закрыть чат");
    sessionStorage.setItem(STORAGE_OPEN, "1");
    sessionStorage.setItem(STORAGE_GREETED, "1");
    post({ type: "eb:open" });
  }

  function close() {
    isOpen = false;
    wrap.classList.remove("open");
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute("aria-label", "Открыть чат с консультантом");
    sessionStorage.removeItem(STORAGE_OPEN);
    launcher.focus({ preventScroll: true });
  }

  const toggle = () => (isOpen ? close() : open());

  function ask(question: string) {
    open();
    if (question.trim()) post({ type: "eb:ask", text: question.trim() });
  }

  function onMessage(e: MessageEvent) {
    if (e.origin !== origin || !iframe || e.source !== iframe.contentWindow) return;
    const data = e.data as { type?: string };
    if (data?.type === "eb:ready") {
      ready = true;
      while (queue.length) iframe.contentWindow!.postMessage(queue.shift(), origin);
    } else if (data?.type === "eb:close") close();
    else if (data?.type === "eb:unread" && !isOpen) wrap.classList.add("unread");
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && isOpen) close();
  }

  function onAskClick(e: MouseEvent) {
    const el = (e.target as Element | null)?.closest?.("[data-energytool-ask]");
    if (!el) return;
    e.preventDefault();
    ask(el.getAttribute("data-energytool-ask") || "");
  }

  launcher.addEventListener("click", toggle);
  bubble.addEventListener("click", (e) => {
    const quick = (e.target as Element).closest<HTMLElement>("[data-q]");
    if (quick) {
      ask(quick.dataset.q || "");
      return;
    }
    if ((e.target as Element).closest(".x")) {
      hideBubble();
      sessionStorage.setItem(STORAGE_GREETED, "1");
      return;
    }
    open();
  });
  window.addEventListener("message", onMessage);
  document.addEventListener("keydown", onKey);
  document.addEventListener("click", onAskClick, true);

  const mount = () => {
    document.body.appendChild(host);
    if (cfg.open || sessionStorage.getItem(STORAGE_OPEN)) open();
    else if (cfg.greeting && !sessionStorage.getItem(STORAGE_GREETED) && cfg.greetingDelay >= 0) {
      setTimeout(() => !isOpen && bubble.classList.add("show"), cfg.greetingDelay * 1000);
    }
    // Чат подгружаем по намерению — наведение или фокус на кнопке и подсказке, — чтобы открытие было мгновенным,
    // а запасной вариант — через несколько секунд в простое: сайт клиента сначала грузит своё, потом наш чат.
    for (const el of [launcher, bubble]) {
      el.addEventListener("pointerenter", ensureFrame, { once: true });
      el.addEventListener("focusin", ensureFrame, { once: true });
      el.addEventListener("touchstart", ensureFrame, { once: true, passive: true });
    }
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
    setTimeout(() => (idle ? idle(ensureFrame) : ensureFrame()), 6000);
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });

  window.EnergyToolChat = {
    open,
    close,
    toggle,
    ask,
    destroy() {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onAskClick, true);
      host.remove();
      delete window.EnergyToolChat;
    },
    get isOpen() {
      return isOpen;
    },
    version: VERSION,
  };
})();

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export {};
