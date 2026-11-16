/** Плавная прокрутка контейнера с easing (easeInOutCubic). При prefers-reduced-motion — сразу, без анимации. */

const running = new WeakMap<Element, () => void>();

function reduced() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Позиция элемента относительно содержимого контейнера. */
function offsetIn(root: HTMLElement, el: HTMLElement) {
  return el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
}

export function scrollToElement(
  root: HTMLElement,
  el: HTMLElement,
  { align = "start", offset = 24, duration = 420 }: { align?: "start" | "center"; offset?: number; duration?: number } = {},
) {
  running.get(root)?.();
  const max = root.scrollHeight - root.clientHeight;
  const wanted = offsetIn(root, el) - (align === "center" ? (root.clientHeight - el.offsetHeight) / 2 : offset);
  const to = Math.max(0, Math.min(max, wanted));
  const from = root.scrollTop;
  if (reduced() || Math.abs(to - from) < 2) {
    root.scrollTop = to;
    return;
  }
  const t0 = performance.now();
  let raf = 0;
  const stop = () => {
    cancelAnimationFrame(raf);
    root.removeEventListener("wheel", stop);
    root.removeEventListener("touchstart", stop);
    root.removeEventListener("keydown", stop);
    running.delete(root);
  };
  const tick = (now: number) => {
    const p = Math.min(1, (now - t0) / duration);
    const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    root.scrollTop = from + (to - from) * e;
    if (p < 1) raf = requestAnimationFrame(tick);
    else stop();
  };
  // пользователь взял прокрутку в свои руки — не мешаем
  root.addEventListener("wheel", stop, { passive: true });
  root.addEventListener("touchstart", stop, { passive: true });
  root.addEventListener("keydown", stop);
  running.set(root, stop);
  raf = requestAnimationFrame(tick);
}

/** Перезапуск CSS-анимации подсветки на элементе. */
export function flash(el: HTMLElement, cls: string) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}
