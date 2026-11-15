"use client";

import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Lock,
  MessageCircle,
  Monitor,
  MousePointerClick,
  Palette,
  Pipette,
  Plus,
  RotateCcw,
  Route,
  Smartphone,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AppShell, PageBar } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { TOPICS, type TopicName, topicByName } from "@/components/chat/topics";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { matchTopic } from "@/lib/page-context";
import { cn } from "@/lib/utils";

/** Строка data-topics: префикс пути страницы сайта → тема приветствия и первых вопросов в чате. */
interface TopicRule {
  prefix: string;
  topic: TopicName;
}

interface Settings {
  title: string;
  color: string;
  position: "right" | "left";
  greeting: string;
  quick: string[];
  delay: number;
  topics: TopicRule[];
}

const DEFAULTS: Settings = {
  title: "Консультант EnergyTool",
  color: "#FF0032",
  position: "right",
  greeting: "Здравствуйте! Подберу решение по энергоучёту, потерям и солнечной генерации.",
  quick: ["Как снизить расходы на электроэнергию?", "Окупится ли солнечная станция?"],
  delay: 3,
  topics: [
    { prefix: "/solar", topic: "solar" },
    { prefix: "/askue", topic: "askue" },
  ],
};

const TOPIC_NAMES = Object.keys(TOPICS) as TopicName[];

const COLORS = [
  { value: "#FF0032", name: "Красный МТС" },
  { value: "#1D2023", name: "Графит" },
  { value: "#007CFF", name: "Синий" },
  { value: "#00B956", name: "Зелёный" },
];

const TRY = [
  { label: "Солнечные панели", text: "Подойдут ли нам солнечные панели на крыше склада?" },
  { label: "Поиск потерь", text: "Как найти, где теряется электроэнергия в нашей сети?" },
];

const LIMITS = { title: 40, greeting: 140, quick: 60, prefix: 60, topics: 8 };
const isHex = (v: string) => /^#[0-9a-f]{6}$/i.test(v);
const quickList = (s: Settings) => s.quick.map((q) => q.trim()).filter(Boolean).slice(0, 3);
const attr = (v: string) => v.replace(/"/g, "&quot;");
/** Тот же формат префикса, что принимает загрузчик (src/lib/page-context.ts). */
const isPrefix = (v: string) => /^\/[^\s"'<>]{0,199}$/.test(v);

/** data-topics как объект: только верные префиксы, повтор префикса — последняя строка. */
function topicsMap(s: Settings) {
  const out: Record<string, string> = {};
  for (const { prefix, topic } of s.topics) if (isPrefix(prefix.trim())) out[prefix.trim()] = topic;
  return out;
}

function snippet(origin: string, s: Settings) {
  const topics = topicsMap(s);
  // JSON с двойными кавычками — в одинарных кавычках атрибута; одинарных в префиксах нет (isPrefix).
  const topicsAttr = Object.keys(topics).length ? `\n  data-topics='${JSON.stringify(topics)}'` : "";
  return `<script src="${origin}/widget.js" async
  data-title="${attr(s.title)}"
  data-color="${s.color}"
  data-position="${s.position}"
  data-greeting="${attr(s.greeting)}"
  data-quick="${attr(quickList(s).join("|"))}"
  data-greeting-delay="${s.delay}"${topicsAttr}></script>`;
}

function useCopy() {
  const [done, setDone] = useState(false);
  return {
    done,
    copy: (text: string) => {
      void navigator.clipboard.writeText(text);
      setDone(true);
      toast.success("Код скопирован");
      setTimeout(() => setDone(false), 1500);
    },
  };
}

function CopyBlock({ code, label }: { code: string; label: string }) {
  const { done, copy } = useCopy();
  return (
    <div className="relative overflow-hidden rounded-xl bg-[#17191c] ring-1 ring-border dark:ring-white/8">
      <div className="flex h-10 items-center justify-between border-b border-white/8 pr-1.5 pl-4">
        <span className="font-mono text-xs text-white/50">{label}</span>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-white/70 transition-colors hover:bg-[#2c2f34] hover:text-white"
          onClick={() => copy(code)}
        >
          {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {done ? "Скопировано" : "Копировать"}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[12.5px] leading-relaxed text-white/90">{code}</pre>
    </div>
  );
}

/** Та самая «одна строка» — прямо под заголовком, с копированием полного тега. */
function OneLine({ origin, full }: { origin: string; full: string }) {
  const { done, copy } = useCopy();
  return (
    <div className="flex h-12 w-fit max-w-full items-center gap-4 rounded-xl bg-[#17191c] pr-1.5 pl-4 ring-1 ring-border dark:ring-white/8">
      <code className="min-w-0 truncate font-mono text-[13px] text-white/90">
        <span className="text-white/45">&lt;</span>
        <span className="text-[#ff7a8f]">script</span> <span className="text-[#9cc4ff]">src</span>
        <span className="text-white/45">=</span>
        <span className="text-[#a8e1b8]">&quot;{origin}/widget.js&quot;</span> <span className="text-[#9cc4ff]">async</span>
        <span className="text-white/45">&gt;&lt;/</span>
        <span className="text-[#ff7a8f]">script</span>
        <span className="text-white/45">&gt;</span>
      </code>
      <button
        type="button"
        onClick={() => copy(full)}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-[#2c2f34] px-3 text-[13px] font-medium text-white transition-colors hover:bg-[#383c42]"
      >
        {done ? <Check className="size-4" /> : <Copy className="size-4" />}
        {done ? "Скопировано" : "Скопировать тег"}
      </button>
    </div>
  );
}

function Counter({ value, max }: { value: number; max: number }) {
  return (
    <span className={cn("tnum ml-auto text-xs font-normal", value > max ? "text-destructive" : "text-muted-foreground")}>
      {value}/{max}
    </span>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  aside,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline gap-2">
        <Label htmlFor={htmlFor} className="text-[13px]">
          {label}
        </Label>
        {aside}
      </div>
      {children}
      {hint && <p className="text-xs leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Panel({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-5 border-t p-5 first:border-t-0">
      <h2 className="flex items-center gap-2.5 text-[14px] font-semibold">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-white">
          <Icon className="size-4" />
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Сторона экрана — схемой экрана, а не словами: видно, где окажется кнопка. */
function SidePicker({ value, onChange, color }: { value: Settings["position"]; onChange: (v: Settings["position"]) => void; color: string }) {
  return (
    <div className="grid grid-cols-2 gap-2.5" role="radiogroup" aria-label="Сторона экрана">
      {(["left", "right"] as const).map((side) => {
        const on = value === side;
        return (
          <button
            key={side}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(side)}
            className={cn(
              "grid gap-2 rounded-xl border p-2.5 text-left transition-colors hover:bg-muted",
              on && "border-foreground/70 ring-1 ring-foreground/70 hover:bg-transparent",
            )}
          >
            <span className="relative block h-12 rounded-md border bg-surface">
              <span className="absolute inset-x-2 top-2 h-1 rounded-full bg-border" />
              <span className="absolute top-4.5 left-2 h-1 w-1/2 rounded-full bg-border" />
              <span
                className={cn("absolute bottom-1.5 size-3 rounded-full transition-all", side === "left" ? "left-1.5" : "right-1.5")}
                style={{ background: on ? color : "var(--muted-foreground)", opacity: on ? 1 : 0.45 }}
              />
            </span>
            <span className={cn("px-0.5 text-[13px]", on ? "font-medium" : "text-muted-foreground")}>
              {side === "left" ? "Слева" : "Справа"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** data-topics строками: префикс пути → тема из базы. Своё приветствие и первые вопросы — в чате на этих страницах. */
function TopicRules({ value, onChange }: { value: TopicRule[]; onChange: (v: TopicRule[]) => void }) {
  const patch = (i: number, p: Partial<TopicRule>) => onChange(value.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <>
      {value.length > 0 && (
        <ul className="grid gap-2">
          {value.map((r, i) => {
            const bad = !isPrefix(r.prefix.trim());
            return (
              <li key={i} className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-1.5">
                <Input
                  value={r.prefix}
                  maxLength={LIMITS.prefix}
                  placeholder="/solar"
                  aria-label={`Префикс пути ${i + 1}`}
                  aria-invalid={bad}
                  onChange={(e) => patch(i, { prefix: e.target.value })}
                  className="h-9 font-mono text-[13px] md:text-[13px]"
                />
                <span className="relative inline-flex min-w-0">
                  <select
                    value={r.topic}
                    onChange={(e) => patch(i, { topic: e.target.value as TopicName })}
                    aria-label={`Тема для ${r.prefix || `строки ${i + 1}`}`}
                    className="h-9 w-full min-w-0 appearance-none truncate rounded-lg border border-input bg-background pr-7 pl-2.5 text-[13px] outline-none transition-colors hover:border-ring/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                  >
                    {TOPIC_NAMES.map((name) => (
                      <option key={name} value={name}>
                        {TOPICS[name].label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground" />
                </span>
                <button
                  type="button"
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                  aria-label={`Удалить тему ${i + 1}`}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-60 transition hover:bg-muted hover:text-foreground hover:opacity-100"
                >
                  <X className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {value.length < LIMITS.topics && (
        <button
          type="button"
          onClick={() => {
            const used = new Set(value.map((r) => r.topic));
            const topic = TOPIC_NAMES.find((n) => !used.has(n)) ?? TOPIC_NAMES[0];
            onChange([...value, { prefix: "/", topic }]);
          }}
          className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-dashed text-[13px] text-muted-foreground transition-colors hover:border-input hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-3.5" /> Добавить страницу
        </button>
      )}
    </>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: React.ElementType; iconOnly?: boolean; disabled?: boolean }[];
  label: string;
}) {
  return (
    <div className="inline-flex w-fit max-w-full overflow-x-auto rounded-lg bg-muted p-1" role="radiogroup" aria-label={label}>
      {options.map(({ value: v, label: l, icon: Icon, iconOnly, disabled }) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          aria-label={iconOnly ? l : undefined}
          title={iconOnly ? l : undefined}
          disabled={disabled}
          onClick={() => onChange(v)}
          className={cn(
            "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
            value === v && "bg-background text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08)] dark:bg-accent",
          )}
        >
          {Icon && <Icon className="size-3.5" />}
          {!iconOnly && l}
        </button>
      ))}
    </div>
  );
}

/** Точка на шкале: угол в градусах (0 — вправо, против часовой), центр 130/130. */
const dialPoint = (deg: number, r: number) => {
  const a = (deg * Math.PI) / 180;
  return [130 + r * Math.cos(a), 130 - r * Math.sin(a)] as const;
};
const DIAL_FROM = 200;
const DIAL_TO = -20;
const DIAL_ACTIVE = 52;

/**
 * Фигура справа от заголовка: шкала прибора учёта (знак EnergyTool крупно) со стрелкой в красной зоне,
 * поверх — уменьшенные подсказка и кнопка виджета в текущих настройках.
 */
function HeroFigure({ s }: { s: Settings }) {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSettled(true), 120);
    return () => clearTimeout(t);
  }, []);
  const color = isHex(s.color) ? s.color : DEFAULTS.color;
  const [sx, sy] = dialPoint(DIAL_FROM, 100);
  const [ex, ey] = dialPoint(DIAL_TO, 100);
  const [ax, ay] = dialPoint(DIAL_ACTIVE, 100);
  // Стрелка уходит в красную зону: виджет «включён».
  const needle = settled ? 90 - 16 : 90 - DIAL_FROM;
  const ticks = Array.from({ length: 12 }, (_, k) => DIAL_FROM - k * 20);
  const quick = quickList(s)[0];

  return (
    <div aria-hidden className="relative hidden h-[376px] select-none lg:block">
      <div className="absolute top-0 right-0 size-[280px] rounded-[48px] border bg-surface shadow-[var(--shadow-float)]">
        <svg viewBox="0 0 260 260" className="absolute inset-[10px] size-[260px]">
          {ticks.map((t, k) => {
            const [x1, y1] = dialPoint(t, 118);
            const [x2, y2] = dialPoint(t, k % 2 ? 123 : 128);
            return (
              <line
                key={t}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={t <= DIAL_ACTIVE + 4 && t >= DIAL_TO ? color : "var(--dim)"}
                strokeWidth={k % 2 ? 2 : 3}
                strokeLinecap="round"
              />
            );
          })}
          <path
            d={`M${sx} ${sy}A100 100 0 1 1 ${ex} ${ey}`}
            stroke="var(--border)"
            strokeWidth="16"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d={`M${ax} ${ay}A100 100 0 0 1 ${ex} ${ey}`}
            stroke={color}
            strokeWidth="16"
            strokeLinecap="round"
            fill="none"
            className="transition-[stroke] duration-300"
          />
          <g
            style={{ transform: `rotate(${needle}deg)`, transformOrigin: "130px 130px", transformBox: "view-box" }}
            className="transition-transform duration-[1400ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
          >
            <line x1="130" y1="130" x2="130" y2="48" stroke="var(--foreground)" strokeWidth="5" strokeLinecap="round" />
          </g>
          <circle cx="130" cy="130" r="11" fill="var(--foreground)" />
          <circle cx="130" cy="130" r="4" fill="var(--surface)" />
          <text x="130" y="186" textAnchor="middle" className="fill-foreground font-sans text-[30px] font-semibold tracking-tight">
            1
          </text>
          <text x="130" y="206" textAnchor="middle" className="fill-muted-foreground font-sans text-[12px]">
            строка кода
          </text>
        </svg>
      </div>

      <div className="absolute bottom-0 left-0 w-[232px] rounded-[20px] rounded-br-[6px] border bg-background p-3.5 shadow-[var(--shadow-pop)] dark:bg-card">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full text-white" style={{ background: color }}>
            <svg viewBox="0 0 28 28" fill="none" className="size-6">
              <path d="M7.42 19.39A7 7 0 1 1 20.58 19.39" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              <path d="M14 17 17.6 12.7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              <circle cx="14" cy="17" r="1.7" fill="currentColor" />
            </svg>
          </span>
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-[13px] font-semibold">{s.title || "Консультант"}</span>
            <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-success" /> на связи
            </span>
          </span>
        </div>
        <p className="mt-2.5 line-clamp-2 text-[12.5px] leading-snug">{s.greeting}</p>
        {quick && (
          <div className="mt-2.5 truncate rounded-[10px] bg-muted px-2.5 py-1.5 text-[12px] font-medium">{quick}</div>
        )}
      </div>

      <span
        className="absolute top-[244px] right-[-12px] flex size-14 items-center justify-center rounded-full text-white shadow-[0_2px_4px_rgb(29_32_35/0.12),0_10px_28px_rgb(29_32_35/0.22)] transition-colors duration-300"
        style={{ background: color }}
      >
        <MessageCircle className="size-6" />
      </span>
    </div>
  );
}

const FACTS = [
  { title: "Изоляция", text: "Кнопка — в Shadow DOM, чат — в iframe. Стили и скрипты сайта не пересекаются с виджетом." },
  { title: "Мобильные", text: "На узких экранах чат открывается на весь экран, Esc и крестик сворачивают его." },
  { title: "Заявка менеджеру", text: "Контакты и резюме диалога уходят менеджеру — клиенту не нужно повторять задачу." },
];

export function WidgetStudio({ standUrl }: { standUrl: string }) {
  const [s, setS] = useState<Settings>(DEFAULTS);
  const [origin, setOrigin] = useState("https://energytool-ai.example");
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [source, setSource] = useState<"mts" | "blank">("mts");
  const [standUp, setStandUp] = useState<boolean | null>(null);
  const [src, setSrc] = useState("");
  const [nonce, setNonce] = useState(0);
  const [previewPath, setPreviewPath] = useState("/");
  const frame = useRef<HTMLIFrameElement>(null);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => ({ ...x, [k]: v }));
  const stand = standUrl.replace(/\/$/, "");
  const standOrigin = useMemo(() => {
    try {
      return new URL(stand).origin;
    } catch {
      return "";
    }
  }, [stand]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- адрес стенда известен только в браузере
    setOrigin(window.location.origin);
    // Запущен ли стенд с копией сайта МТС; если нет — превью на пустой странице.
    fetch(stand, { mode: "no-cors", cache: "no-store" })
      .then(() => setStandUp(true))
      .catch(() => {
        setStandUp(false);
        setSource("blank");
      });
  }, [stand]);

  const mts = source === "mts" && standUp !== false;

  // Страница превью: главная или одна из страниц с темой — виджет видит этот путь и берёт тему из data-topics.
  const topics = useMemo(() => topicsMap(s), [s]);
  const pages = useMemo(() => ["/", ...Object.keys(topics).filter((p) => p !== "/")], [topics]);
  const path = pages.includes(previewPath) ? previewPath : "/";
  const previewTopic = topicByName(matchTopic(path, topics));

  // Превью — настоящий widget.js: на копии сайта МТС (стенд принимает настройки в адресе) или на заглушке.
  useEffect(() => {
    if (standUp === null) return;
    const t = setTimeout(() => {
      const cfg: Record<string, string> = {
        title: s.title,
        color: isHex(s.color) ? s.color : DEFAULTS.color,
        position: s.position,
        greeting: s.greeting,
        greetingDelay: String(Math.min(s.delay, 1)),
        quick: quickList(s).join("|"),
        path,
      };
      if (Object.keys(topics).length) cfg.topics = JSON.stringify(topics);
      if (mts) {
        const q = new URLSearchParams(Object.entries(cfg).map(([k, v]) => [`w_${k}`, v]));
        q.set("w_preview", "1");
        q.set("n", String(nonce));
        setSrc(`${stand}/?${q}`);
      } else {
        setSrc(`/widget-preview.html?${new URLSearchParams({ ...cfg, n: String(nonce) })}`);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [s, nonce, mts, stand, standUp, path, topics]);

  const command = (action: "ask" | "toggle", text?: string) => {
    const win = frame.current?.contentWindow;
    if (!win) return;
    if (mts) win.postMessage({ type: "eb:preview", action, text }, standOrigin);
    else if (action === "ask") win.EnergyToolChat?.ask(text ?? "");
    else win.EnergyToolChat?.toggle();
  };

  const code = useMemo(() => snippet(origin, s), [origin, s]);
  const quick = s.quick;
  const host = mts ? "energytool.mts.ru" : "ваш-сайт.ru";

  return (
    <AppShell>
      <PageBar icon={Code2} title="Виджет для сайта" subtitle="встраивание консультанта">
        <Button nativeButton={false} render={<a href={stand} target="_blank" rel="noreferrer" />}>
          Сайт МТС с виджетом <ArrowUpRight />
        </Button>
      </PageBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1180px] px-5 pt-6 pb-24 sm:px-8">
          <header className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_400px]">
            <div className="grid gap-5">
            <h1 className="text-[34px] leading-[1.08] font-semibold tracking-[-0.03em] sm:text-[40px]">
              Консультант на любом сайте —
              <br />
              <span className="text-muted-foreground">одной строкой.</span>
            </h1>
            <p className="max-w-[560px] text-[15px] leading-relaxed text-pretty text-muted-foreground">
              Вставьте тег перед <span className="font-mono text-[13px] text-foreground">&lt;/body&gt;</span> — сайту больше
              ничего менять не нужно. Чат живёт в изолированном iframe, стили не пересекаются. Ниже — настоящий виджет на
              копии сайта МТС: он меняется вместе с настройками.
            </p>
            <OneLine origin={origin} full={code} />
           </div>
            <HeroFigure s={s} />
          </header>

          <div className="mt-12 grid gap-8 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:gap-10">
            <div className="grid content-start gap-3">
              <div className="overflow-hidden rounded-2xl border bg-background shadow-[var(--shadow-float)] dark:bg-card">
                <Panel icon={Palette} title="Внешний вид">
                  <Field label="Заголовок" htmlFor="w-title" aside={<Counter value={s.title.length} max={LIMITS.title} />}>
                    <Input
                      id="w-title"
                      value={s.title}
                      maxLength={LIMITS.title}
                      onChange={(e) => set("title", e.target.value)}
                    />
                  </Field>
                  <Field label="Цвет кнопки">
                    <div className="flex flex-wrap items-center gap-2">
                      {COLORS.map((c) => {
                        const on = s.color.toLowerCase() === c.value.toLowerCase();
                        return (
                          <button
                            key={c.value}
                            type="button"
                            onClick={() => set("color", c.value)}
                            className={cn(
                              "flex size-9 items-center justify-center rounded-full shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14),0_0_0_1px_var(--border)] transition-transform outline-none hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                              on && "ring-2 ring-foreground/80 ring-offset-2 ring-offset-background",
                            )}
                            style={{ background: c.value }}
                            aria-label={c.name}
                            aria-pressed={on}
                            title={c.name}
                          >
                            {on && <Check className="size-4 text-white" strokeWidth={3} />}
                          </button>
                        );
                      })}
                      <label
                        title="Свой цвет"
                        className="relative flex size-9 cursor-pointer items-center justify-center rounded-full border border-dashed text-muted-foreground transition-colors hover:border-input hover:text-foreground"
                      >
                        <Pipette className="size-4" />
                        <input
                          type="color"
                          value={isHex(s.color) ? s.color : DEFAULTS.color}
                          onChange={(e) => set("color", e.target.value.toUpperCase())}
                          className="absolute inset-0 cursor-pointer opacity-0"
                          aria-label="Выбрать свой цвет"
                        />
                      </label>
                    </div>
                    <div className="relative mt-1 w-[148px]">
                      <span
                        className="absolute top-1/2 left-3 size-4 -translate-y-1/2 rounded-full ring-1 ring-border"
                        style={{ background: isHex(s.color) ? s.color : "transparent" }}
                      />
                      <Input
                        value={s.color}
                        onChange={(e) => set("color", e.target.value)}
                        aria-label="Цвет в HEX"
                        aria-invalid={!isHex(s.color)}
                        className="h-9 pl-9 font-mono text-[13px] uppercase md:text-[13px]"
                      />
                    </div>
                  </Field>
                  <Field label="Сторона экрана">
                    <SidePicker value={s.position} onChange={(v) => set("position", v)} color={isHex(s.color) ? s.color : DEFAULTS.color} />
                  </Field>
                </Panel>

                <Panel icon={MessageCircle} title="Подсказка у кнопки">
                  <Field
                    label="Приветствие"
                    htmlFor="w-greeting"
                    aside={<Counter value={s.greeting.length} max={LIMITS.greeting} />}
                  >
                    <Textarea
                      id="w-greeting"
                      rows={3}
                      maxLength={LIMITS.greeting}
                      value={s.greeting}
                      onChange={(e) => set("greeting", e.target.value)}
                      className="field-sizing-fixed resize-none"
                    />
                  </Field>
                  <Field
                    label="Быстрые вопросы"
                    hint="Клик по вопросу открывает чат и сразу задаёт его."
                    aside={<span className="tnum ml-auto text-xs text-muted-foreground">{quickList(s).length}/3</span>}
                  >
                    <ol className="grid gap-2">
                      {quick.map((q, i) => (
                        <li key={i} className="group relative">
                          <span className="tnum pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-[11px] text-muted-foreground">
                            {i + 1}
                          </span>
                          <Input
                            value={q}
                            maxLength={LIMITS.quick}
                            placeholder="Вопрос клиента"
                            aria-label={`Быстрый вопрос ${i + 1}`}
                            onChange={(e) => set("quick", quick.map((x, j) => (j === i ? e.target.value : x)))}
                            className="h-9 pr-9 pl-8"
                          />
                          <button
                            type="button"
                            onClick={() => set("quick", quick.filter((_, j) => j !== i))}
                            aria-label={`Удалить вопрос ${i + 1}`}
                            className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-60 transition hover:bg-muted hover:text-foreground hover:opacity-100"
                          >
                            <X className="size-3.5" />
                          </button>
                        </li>
                      ))}
                    </ol>
                    {quick.length < 3 && (
                      <button
                        type="button"
                        onClick={() => set("quick", [...quick, ""])}
                        className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-dashed text-[13px] text-muted-foreground transition-colors hover:border-input hover:bg-muted hover:text-foreground"
                      >
                        <Plus className="size-3.5" /> Добавить вопрос
                      </button>
                    )}
                  </Field>
                  <Field
                    label="Показать подсказку через"
                    htmlFor="w-delay"
                    aside={<span className="tnum ml-auto text-[13px] font-medium">{s.delay} с</span>}
                  >
                    <input
                      id="w-delay"
                      type="range"
                      min={0}
                      max={30}
                      step={1}
                      value={s.delay}
                      onChange={(e) => set("delay", Number(e.target.value))}
                      className="h-5 w-full cursor-pointer accent-[var(--brand)]"
                    />
                    <div className="tnum -mt-1 flex justify-between text-[11px] text-muted-foreground">
                      <span>сразу</span>
                      <span>30 с</span>
                    </div>
                  </Field>
                </Panel>

                <Panel icon={Route} title="Темы страниц">
                  <Field
                    label="Префикс пути → тема"
                    hint="На странице с этим началом пути чат здоровается и предлагает первые вопросы по продукту. Совпадает самый длинный префикс; на остальных страницах — общее приветствие."
                    aside={
                      <span className="tnum ml-auto text-xs text-muted-foreground">
                        {s.topics.length}/{LIMITS.topics}
                      </span>
                    }
                  >
                    <TopicRules value={s.topics} onChange={(v) => set("topics", v)} />
                  </Field>
                </Panel>
              </div>
              <button
                type="button"
                onClick={() => setS(DEFAULTS)}
                className="inline-flex w-fit items-center gap-1.5 px-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <RotateCcw className="size-3.5" /> Вернуть настройки по умолчанию
              </button>
            </div>

            <section aria-labelledby="w-preview" className="min-w-0 lg:sticky lg:top-4 lg:self-start">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2 id="w-preview" className="mr-auto text-[15px] font-semibold">
                  Превью
                </h2>
                <Segmented
                  label="Страница для превью"
                  value={mts ? "mts" : "blank"}
                  onChange={setSource}
                  options={[
                    { value: "mts", label: "Сайт МТС", disabled: standUp === false },
                    { value: "blank", label: "Пустая страница" },
                  ]}
                />
                <Segmented
                  label="Устройство"
                  value={device}
                  onChange={setDevice}
                  options={[
                    { value: "desktop", label: "Компьютер", icon: Monitor, iconOnly: true },
                    { value: "phone", label: "Телефон", icon: Smartphone, iconOnly: true },
                  ]}
                />
              </div>

              <div className="overflow-hidden rounded-2xl border bg-background shadow-[var(--shadow-pop)] dark:bg-card">
                <div className="flex h-11 items-center gap-3 border-b bg-surface px-3.5">
                  <span className="flex gap-1.5" aria-hidden>
                    <span className="size-2.5 rounded-full bg-dim" />
                    <span className="size-2.5 rounded-full bg-dim" />
                    <span className="size-2.5 rounded-full bg-dim" />
                  </span>
                  <div className="mx-auto flex h-7 w-full max-w-[380px] min-w-0 items-center justify-center gap-1.5 rounded-full border bg-background px-3 text-[12.5px] text-muted-foreground dark:bg-background">
                    <Lock className="size-3 shrink-0" />
                    <span className="truncate text-foreground/80">
                      {host}
                      {path !== "/" && <span className="text-muted-foreground">{path}</span>}
                    </span>
                    {mts && <span className="shrink-0 text-muted-foreground/70">· копия для стенда</span>}
                  </div>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          onClick={() => setNonce((n) => n + 1)}
                          aria-label="Обновить страницу"
                          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        />
                      }
                    >
                      <RotateCcw className="size-3.5" />
                    </TooltipTrigger>
                    <TooltipContent>Обновить: снова показать подсказку</TooltipContent>
                  </Tooltip>
                </div>
                <div className="flex justify-center bg-muted">
                  {src ? (
                    <iframe
                      ref={frame}
                      key={`${device}-${mts}`}
                      src={src}
                      title={mts ? "Превью: сайт МТС EnergyTool с виджетом" : "Превью виджета на странице сайта"}
                      className={cn(
                        "block h-[clamp(600px,calc(100dvh-170px),780px)] border-0 bg-white",
                        device === "phone" ? "w-[390px] border-x" : "w-full",
                      )}
                    />
                  ) : (
                    <div className="h-[clamp(600px,calc(100dvh-170px),780px)] w-full animate-pulse bg-muted" />
                  )}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="mr-0.5 text-[13px] text-muted-foreground">Страница:</span>
                <Segmented
                  label="Страница сайта в превью"
                  value={path}
                  onChange={setPreviewPath}
                  options={pages.map((p) => ({ value: p, label: p === "/" ? "Главная" : p }))}
                />
                <span className="text-[13px] text-muted-foreground">
                  {previewTopic ? (
                    <>
                      тема <span className="font-medium text-foreground">«{previewTopic.label}»</span> — откройте чат
                    </>
                  ) : (
                    "общее приветствие"
                  )}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="mr-0.5 text-[13px] text-muted-foreground">Спросить в превью:</span>
                {TRY.map((t) => (
                  <Button key={t.label} variant="outline" size="sm" onClick={() => command("ask", t.text)}>
                    <MousePointerClick /> {t.label}
                  </Button>
                ))}
                <Button variant="ghost" size="sm" className="ml-auto" onClick={() => command("toggle")}>
                  Открыть / закрыть чат
                </Button>
              </div>
              {standUp === false && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Стенд с сайтом МТС не запущен — превью на пустой странице. Запуск:{" "}
                  <code className="font-mono">node web/scripts/stand.mjs --site &lt;папка сайта&gt;</code>
                </p>
              )}
            </section>
          </div>

          <section aria-labelledby="w-install" className="mt-20">
            <h2 id="w-install" className="text-[24px] font-semibold tracking-[-0.02em]">
              Установка
            </h2>
            <ol className="mt-6 grid gap-10 lg:grid-cols-2 lg:gap-12">
              <li className="grid content-start gap-4">
                <div className="flex gap-3">
                  <span className="tnum flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-[13px] font-semibold text-background">
                    1
                  </span>
                  <div>
                    <h3 className="text-[15px] leading-7 font-semibold">Вставьте тег перед &lt;/body&gt;</h3>
                    <p className="text-[13px] text-muted-foreground">Настройки слева уже в коде, адрес стенда подставлен</p>
                  </div>
                </div>
                <CopyBlock code={code} label="index.html" />
              </li>
              <li className="grid content-start gap-4">
                <div className="flex gap-3">
                  <span className="tnum flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[13px] font-semibold text-muted-foreground">
                    2
                  </span>
                  <div>
                    <h3 className="text-[15px] leading-7 font-semibold">
                      Свяжите кнопки сайта <span className="font-normal text-muted-foreground">— по желанию</span>
                    </h3>
                    <p className="text-[13px] text-muted-foreground">Например, «Спросить консультанта» в карточке продукта</p>
                  </div>
                </div>
                <CopyBlock
                  label="script.js"
                  code={`EnergyToolChat.open();   // открыть
EnergyToolChat.close();  // закрыть
EnergyToolChat.ask("Подойдут ли нам солнечные панели?");

<!-- или без кода: -->
<button data-energytool-ask="Как сократить потери в сетях СНТ?">
  Спросить консультанта
</button>`}
                />
              </li>
            </ol>
          </section>

          <dl className="mt-20 grid gap-8 border-t pt-8 sm:grid-cols-3">
            {FACTS.map(({ title, text }) => (
              <div key={title}>
                <dt className="text-[14px] font-semibold">{title}</dt>
                <dd className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">{text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </AppShell>
  );
}
