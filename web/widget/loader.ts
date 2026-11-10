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
    subtitle: d.subtitle || "ИИ-помощник · отвечает по базе знаний МТС",
    color: d.color && hex.test(d.color) ? d.color : "#FF0032",
    position: d.position === "left" ? "left" : "right",
    greeting: d.greeting ?? "Здравствуйте! Подберу решение по энергоучёту, потерям и солнечной генерации.",
    greetingDelay: Number(d.greetingDelay ?? 6),
    offsetX: Number(d.offsetX ?? 24),
    offsetY: Number(d.offsetY ?? 24),
    open: d.open === "true",
  };

  const side = cfg.position;
  const host = document.createElement("div");
  host.id = "energytool-chat";
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483000;";
  const root = host.attachShadow({ mode: "open" });

  root.innerHTML = `
<style>
  :host { --c: ${cfg.color}; }
  * { box-sizing: border-box; }
  .launcher {
    position: fixed; bottom: ${cfg.offsetY}px; ${side}: ${cfg.offsetX}px;
    width: 60px; height: 60px; border-radius: 50%; border: 0; cursor: pointer;
    background: var(--c); color: #fff; display: grid; place-items: center;
    box-shadow: 0 8px 24px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.12);
    transition: transform .2s ease, box-shadow .2s ease;
  }
  .launcher:hover { transform: scale(1.06); box-shadow: 0 10px 30px rgba(0,0,0,.22); }
  .launcher:focus-visible { outline: 3px solid color-mix(in srgb, var(--c) 40%, white); outline-offset: 3px; }
  .launcher svg { width: 28px; height: 28px; transition: transform .25s ease, opacity .2s ease; position: absolute; }
  .launcher .i-close { transform: rotate(-90deg) scale(.6); opacity: 0; }
  .open .launcher .i-chat { transform: rotate(90deg) scale(.6); opacity: 0; }
  .open .launcher .i-close { transform: none; opacity: 1; }
  .badge {
    position: absolute; top: 2px; ${side === "right" ? "right" : "left"}: 2px; width: 14px; height: 14px;
    border-radius: 50%; background: #1D2023; border: 2px solid #fff; display: none;
  }
  .unread .badge { display: block; }
  .bubble {
    position: fixed; bottom: ${cfg.offsetY + 74}px; ${side}: ${cfg.offsetX}px; max-width: 280px;
    background: #fff; color: #1D2023; border-radius: 18px; border-${side === "right" ? "bottom-right" : "bottom-left"}-radius: 6px;
    padding: 12px 34px 12px 14px; font: 14px/1.4 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    box-shadow: 0 10px 30px rgba(0,0,0,.14), 0 0 0 1px rgba(0,0,0,.04); cursor: pointer;
    opacity: 0; transform: translateY(8px); pointer-events: none; transition: opacity .25s ease, transform .25s ease;
  }
  .bubble.show { opacity: 1; transform: none; pointer-events: auto; }
  .bubble b { display: block; font-size: 12px; color: #626C77; font-weight: 500; margin-bottom: 2px; }
  .bubble .x { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; border: 0; background: none;
    color: #969FA8; cursor: pointer; border-radius: 50%; font-size: 16px; line-height: 1; }
  .bubble .x:hover { background: #F2F3F7; color: #1D2023; }
  .panel {
    position: fixed; bottom: ${cfg.offsetY + 76}px; ${side}: ${cfg.offsetX}px;
    width: 400px; height: min(680px, calc(100vh - ${cfg.offsetY + 100}px));
    border-radius: 20px; overflow: hidden; background: #fff;
    box-shadow: 0 20px 60px rgba(0,0,0,.22), 0 0 0 1px rgba(0,0,0,.05);
    opacity: 0; transform: translateY(16px) scale(.98); transform-origin: bottom ${side};
    pointer-events: none; visibility: hidden;
    transition: opacity .22s ease, transform .22s ease, visibility 0s linear .22s;
  }
  .open .panel { opacity: 1; transform: none; pointer-events: auto; visibility: visible; transition-delay: 0s; }
  iframe { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
  .loading { position: absolute; inset: 0; display: grid; place-items: center; color: #969FA8;
    font: 13px -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  @media (max-width: 640px) {
    .panel { inset: 0; width: 100%; height: 100%; border-radius: 0; bottom: 0; ${side}: 0; }
    .open .launcher { display: none; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
<div class="wrap">
  <div class="panel" role="dialog" aria-label="${escapeHtml(cfg.title)}" aria-modal="false">
    <div class="loading">Загрузка консультанта…</div>
  </div>
  <div class="bubble" role="status">
    <b>${escapeHtml(cfg.title)}</b><span class="text">${escapeHtml(cfg.greeting)}</span>
    <button class="x" aria-label="Скрыть подсказку">×</button>
  </div>
  <button class="launcher" aria-label="Открыть чат с консультантом" aria-expanded="false">
    <svg class="i-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12Z"/><path d="M10 9.5a2 2 0 1 1 2.9 1.8c-.6.3-.9.8-.9 1.4v.3"/><path d="M12 16h.01"/></svg>
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
    // Чат подгружаем заранее, когда браузер свободен: открытие будет мгновенным.
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
    if (idle) idle(ensureFrame);
    else setTimeout(ensureFrame, 2500);
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
