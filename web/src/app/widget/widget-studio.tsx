"use client";

import {
  ArrowUpRight,
  Braces,
  FileCode2,
  Globe,
  Headset,
  Layers,
  Check,
  Copy,
  Lock,
  Monitor,
  MousePointerClick,
  Pipette,
  Plus,
  RotateCcw,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface Settings {
  title: string;
  color: string;
  position: "right" | "left";
  greeting: string;
  quick: string[];
  delay: number;
}

const DEFAULTS: Settings = {
  title: "Консультант EnergyTool",
  color: "#FF0032",
  position: "right",
  greeting: "Здравствуйте! Подберу решение по энергоучёту, потерям и солнечной генерации.",
  quick: ["Как снизить расходы на электроэнергию?", "Окупится ли солнечная станция?"],
  delay: 3,
};

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

const LIMITS = { title: 40, greeting: 140, quick: 60 };
const isHex = (v: string) => /^#[0-9a-f]{6}$/i.test(v);
const quickList = (s: Settings) => s.quick.map((q) => q.trim()).filter(Boolean).slice(0, 3);
const attr = (v: string) => v.replace(/"/g, "&quot;");

function snippet(origin: string, s: Settings) {
  return `<script src="${origin}/widget.js" async
  data-title="${attr(s.title)}"
  data-color="${s.color}"
  data-position="${s.position}"
  data-greeting="${attr(s.greeting)}"
  data-quick="${attr(quickList(s).join("|"))}"
  data-greeting-delay="${s.delay}"></script>`;
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
    <div className="relative overflow-hidden rounded-lg bg-[#141517] ring-1 ring-border dark:ring-white/8">
      <div className="flex h-9 items-center justify-between border-b border-white/8 pr-1.5 pl-3.5">
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
      <pre className="overflow-x-auto px-3.5 py-3 font-mono text-[12px] leading-relaxed text-white/90">{code}</pre>
    </div>
  );
}

/** Та самая «одна строка» — прямо под заголовком, с копированием полного тега. */
function OneLine({ origin, full }: { origin: string; full: string }) {
  const { done, copy } = useCopy();
  return (
    <div className="flex h-11 w-fit max-w-full items-center gap-4 rounded-lg bg-[#141517] pr-1.5 pl-3.5 ring-1 ring-border dark:ring-white/8">
      <code className="min-w-0 truncate font-mono text-[12px] text-white/90">
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
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-white/10 px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-white/16"
      >
        {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
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

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4 border-t py-4 first:border-t-0">
      <h2 className="text-[14px] font-medium">{title}</h2>
      {children}
    </section>
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
    <div className="inline-flex w-fit rounded-md bg-muted p-0.5" role="radiogroup" aria-label={label}>
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
            "flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
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

/** Сводка справа от тега — как панель окружения в Claude Code: строки «иконка — подпись — значение». */
function Summary({ standUp, scriptKb }: { standUp: boolean | null; scriptKb: number | null }) {
  const rows: { icon: React.ElementType; label: string; value: React.ReactNode; title?: string }[] = [
    {
      icon: FileCode2,
      label: "widget.js",
      value: scriptKb ? `${scriptKb.toLocaleString("ru", { maximumFractionDigits: 1 })} КБ · без зависимостей` : "без зависимостей",
    },
    { icon: Layers, label: "Изоляция", value: "Shadow DOM + iframe", title: FACTS[0].text },
    { icon: Smartphone, label: "На телефоне", value: "во весь экран", title: FACTS[1].text },
    { icon: Headset, label: "Заявка", value: "с резюме диалога", title: FACTS[2].text },
    { icon: Braces, label: "JS API", value: <span className="font-mono text-[11px]">open · close · ask</span> },
    {
      icon: Globe,
      label: "Копия сайта МТС",
      value: (
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn("size-1.5 rounded-full", standUp ? "bg-success" : standUp === false ? "bg-dim" : "bg-dim animate-pulse")}
          />
          {standUp ? "запущена" : standUp === false ? "не запущена" : "проверяю…"}
        </span>
      ),
    },
  ];
  return (
    <dl className="self-start border-y py-1.5 lg:border-y-0 lg:border-l lg:py-0 lg:pl-6">
      <div className="mb-1 hidden text-[12px] font-medium text-muted-foreground lg:block">Как устроено</div>
      {rows.map(({ icon: Icon, label, value, title }) => (
        <div key={label} className="flex min-h-7 items-center gap-2.5 text-[13px]" title={title}>
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <dt className="min-w-0 truncate">{label}</dt>
          <dd className="tnum ml-auto shrink-0 text-right text-[12px] text-muted-foreground">{value}</dd>
        </div>
      ))}
    </dl>
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
  const [scriptKb, setScriptKb] = useState<number | null>(null);
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
    fetch("/widget.js", { cache: "no-store" })
      .then((r) => r.text())
      .then((t) => setScriptKb(Math.round((new Blob([t]).size / 1024) * 10) / 10))
      .catch(() => {});
    // Запущен ли стенд с копией сайта МТС; если нет — превью на пустой странице.
    fetch(stand, { mode: "no-cors", cache: "no-store" })
      .then(() => setStandUp(true))
      .catch(() => {
        setStandUp(false);
        setSource("blank");
      });
  }, [stand]);

  const mts = source === "mts" && standUp !== false;

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
      };
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
  }, [s, nonce, mts, stand, standUp]);

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
      <PageBar title="Виджет для сайта">
        <Button size="sm" nativeButton={false} render={<a href={stand} target="_blank" rel="noreferrer" />}>
          Сайт МТС с виджетом <ArrowUpRight />
        </Button>
      </PageBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1180px] px-5 pt-6 pb-24 sm:px-8">
          <header className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="grid content-start gap-4">
            <p className="max-w-[640px] text-[14px] leading-relaxed text-pretty text-muted-foreground">
              Вставьте тег перед <span className="font-mono text-[13px] text-foreground">&lt;/body&gt;</span> — сайту больше
              ничего менять не нужно. Чат живёт в изолированном iframe, стили не пересекаются. Ниже — настоящий виджет на
              копии сайта МТС: он меняется вместе с настройками.
            </p>
            <OneLine origin={origin} full={code} />
            </div>
            <Summary standUp={standUp} scriptKb={scriptKb} />
          </header>

          <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:gap-8">
            <div className="grid content-start gap-3">
              <div className="border-y">
                <Panel title="Внешний вид">
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
                              "flex size-8 items-center justify-center rounded-full shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14),0_0_0_1px_var(--border)] transition-transform outline-none hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
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
                        className="relative flex size-8 cursor-pointer items-center justify-center rounded-full border border-dashed text-muted-foreground transition-colors hover:border-input hover:text-foreground"
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
                    <Segmented
                      label="Сторона экрана"
                      value={s.position}
                      onChange={(v) => set("position", v)}
                      options={[
                        { value: "left", label: "Слева" },
                        { value: "right", label: "Справа" },
                      ]}
                    />
                  </Field>
                </Panel>

                <Panel title="Подсказка у кнопки">
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
                      className="h-5 w-full cursor-pointer accent-[var(--foreground)]"
                    />
                    <div className="tnum -mt-1 flex justify-between text-[11px] text-muted-foreground">
                      <span>сразу</span>
                      <span>30 с</span>
                    </div>
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
                <h2 id="w-preview" className="mr-auto text-[14px] font-medium">
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

              <div className="overflow-hidden rounded-xl border bg-background dark:bg-card">
                <div className="flex h-10 items-center gap-3 border-b bg-surface px-3">
                  <span className="flex gap-1.5" aria-hidden>
                    <span className="size-2.5 rounded-full bg-dim" />
                    <span className="size-2.5 rounded-full bg-dim" />
                    <span className="size-2.5 rounded-full bg-dim" />
                  </span>
                  <div className="mx-auto flex h-7 w-full max-w-[380px] min-w-0 items-center justify-center gap-1.5 rounded-full border bg-background px-3 text-[12px] text-muted-foreground dark:bg-background">
                    <Lock className="size-3 shrink-0" />
                    <span className="truncate text-foreground/80">{host}</span>
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
                        "block h-[clamp(460px,calc(100dvh-390px),760px)] border-0 bg-white",
                        device === "phone" ? "w-[390px] border-x" : "w-full",
                      )}
                    />
                  ) : (
                    <div className="h-[clamp(460px,calc(100dvh-390px),760px)] w-full animate-pulse bg-muted" />
                  )}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
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

          <section aria-labelledby="w-install" className="mt-16 border-t pt-8">
            <h2 id="w-install" className="text-[18px] font-semibold tracking-[-0.015em]">
              Установка
            </h2>
            <ol className="mt-6 grid gap-10 lg:grid-cols-2 lg:gap-12">
              <li className="grid content-start gap-4">
                <div className="flex gap-3">
                  <span className="tnum flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] text-muted-foreground">
                    1
                  </span>
                  <div>
                    <h3 className="text-[14px] leading-6 font-medium">Вставьте тег перед &lt;/body&gt;</h3>
                    <p className="text-[13px] text-muted-foreground">Настройки слева уже в коде, адрес стенда подставлен</p>
                  </div>
                </div>
                <CopyBlock code={code} label="index.html" />
              </li>
              <li className="grid content-start gap-4">
                <div className="flex gap-3">
                  <span className="tnum flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] text-muted-foreground">
                    2
                  </span>
                  <div>
                    <h3 className="text-[14px] leading-6 font-medium">
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
        </div>
      </div>
    </AppShell>
  );
}
