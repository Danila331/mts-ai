"use client";

import { Check, Copy, ExternalLink, MessageCircleQuestion, MousePointerClick, ShieldCheck, Smartphone } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface Settings {
  title: string;
  color: string;
  position: "right" | "left";
  greeting: string;
  delay: number;
}

const DEFAULTS: Settings = {
  title: "Консультант EnergyTool",
  color: "#FF0032",
  position: "right",
  greeting: "Здравствуйте! Подберу решение по энергоучёту, потерям и солнечной генерации.",
  delay: 3,
};

const COLORS = ["#FF0032", "#1D2023", "#007CFF", "#00B956"];

function snippet(origin: string, s: Settings) {
  return `<script src="${origin}/widget.js" async
  data-title="${s.title}"
  data-color="${s.color}"
  data-position="${s.position}"
  data-greeting="${s.greeting}"
  data-greeting-delay="${s.delay}"></script>`;
}

function CopyBlock({ code }: { code: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-xl bg-[#1d2023] p-4 pr-12 font-mono text-[12px] leading-relaxed text-white/90">
        {code}
      </pre>
      <Button
        size="icon-sm"
        variant="ghost"
        className="absolute top-2 right-2 text-white/70 hover:bg-white/10 hover:text-white"
        onClick={() => {
          void navigator.clipboard.writeText(code);
          setDone(true);
          toast.success("Код скопирован");
          setTimeout(() => setDone(false), 1500);
        }}
        aria-label="Скопировать"
      >
        {done ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

export function WidgetStudio({ standUrl }: { standUrl: string }) {
  const [s, setS] = useState<Settings>(DEFAULTS);
  const [origin, setOrigin] = useState("https://energytool-ai.example");
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- адрес стенда известен только в браузере
    setOrigin(window.location.origin);
  }, []);

  // Живое превью: тот же widget.js, что получит сайт, переподключается при смене настроек.
  useEffect(() => {
    const t = setTimeout(() => {
      window.EnergyToolChat?.destroy();
      document.getElementById("eb-preview-script")?.remove();
      sessionStorage.removeItem("energytool-chat:greeted");
      const el = document.createElement("script");
      el.id = "eb-preview-script";
      el.src = `/widget.js?v=${Date.now()}`;
      el.async = true;
      el.dataset.title = s.title;
      el.dataset.color = s.color;
      el.dataset.position = s.position;
      el.dataset.greeting = s.greeting;
      el.dataset.greetingDelay = String(Math.min(s.delay, 1));
      document.body.appendChild(el);
    }, 400);
    return () => clearTimeout(t);
  }, [s]);

  useEffect(
    () => () => {
      window.EnergyToolChat?.destroy();
      document.getElementById("eb-preview-script")?.remove();
    },
    [],
  );

  const code = useMemo(() => snippet(origin, s), [origin, s]);

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-10">
      <div className="space-y-2">
        <Badge variant="secondary">Встраивание одной строкой</Badge>
        <h1 className="text-3xl font-semibold tracking-tight">Виджет консультанта для любого сайта</h1>
        <p className="max-w-2xl text-muted-foreground">
          Вставьте тег перед <code className="rounded bg-muted px-1 font-mono text-sm">&lt;/body&gt;</code> — на сайте
          появится кнопка консультанта. Сайту ничего не нужно менять: чат работает в изолированном iframe, стили не
          конфликтуют. Превью работает прямо на этой странице — кнопка в углу экрана.
        </p>
        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            nativeButton={false}
            render={<a href={standUrl} target="_blank" rel="noreferrer" />}
            className="bg-brand text-white hover:bg-brand/85"
          >
            Открыть сайт МТС EnergyTool с виджетом <ExternalLink />
          </Button>
          <Button variant="outline" onClick={() => window.EnergyToolChat?.open()}>
            Открыть превью
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Настройки</CardTitle>
            <CardDescription>Меняются через data-атрибуты тега</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="w-title">Заголовок</Label>
              <Input id="w-title" value={s.title} onChange={(e) => set("title", e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Цвет кнопки</Label>
              <div className="flex items-center gap-2">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => set("color", c)}
                    className={cn("size-7 rounded-full ring-offset-2 transition", s.color === c && "ring-2 ring-foreground")}
                    style={{ background: c }}
                    aria-label={c}
                  />
                ))}
                <Input
                  value={s.color}
                  onChange={(e) => set("color", e.target.value)}
                  className="ml-2 h-8 w-28 font-mono text-xs"
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Сторона экрана</Label>
              <div className="flex gap-2">
                {(["left", "right"] as const).map((p) => (
                  <Button
                    key={p}
                    variant={s.position === p ? "default" : "outline"}
                    size="sm"
                    onClick={() => set("position", p)}
                  >
                    {p === "left" ? "Слева" : "Справа"}
                  </Button>
                ))}
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="w-greeting">Проактивная подсказка</Label>
              <Textarea id="w-greeting" rows={2} value={s.greeting} onChange={(e) => set("greeting", e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="w-delay">Показать подсказку через, с</Label>
              <Input
                id="w-delay"
                type="number"
                min={0}
                max={120}
                value={s.delay}
                onChange={(e) => set("delay", Number(e.target.value))}
                className="w-24"
              />
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Код для вставки</CardTitle>
              <CardDescription>Готов к копированию — адрес этого стенда уже подставлен</CardDescription>
            </CardHeader>
            <CardContent>
              <CopyBlock code={code} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>JavaScript API</CardTitle>
              <CardDescription>Кнопки сайта могут открывать консультанта с готовым вопросом</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <CopyBlock
                code={`EnergyToolChat.open();   // открыть
EnergyToolChat.close();  // закрыть
EnergyToolChat.ask("Подойдут ли нам солнечные панели?");

<!-- или без кода: -->
<button data-energytool-ask="Как сократить потери в сетях СНТ?">
  Спросить консультанта
</button>`}
              />
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" data-energytool-ask="Подойдут ли нам солнечные панели на крыше склада?">
                  <MousePointerClick /> Попробовать: солнечные панели
                </Button>
                <Button variant="outline" size="sm" data-energytool-ask="Как найти, где теряется электроэнергия в нашей сети?">
                  <MousePointerClick /> Попробовать: поиск потерь
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { icon: ShieldCheck, title: "Изоляция", text: "Кнопка — в Shadow DOM, чат — в iframe. Стили и скрипты сайта не пересекаются с виджетом." },
          { icon: Smartphone, title: "Мобильные", text: "На узких экранах чат открывается на весь экран, Esc и крестик сворачивают его." },
          { icon: MessageCircleQuestion, title: "Заявка менеджеру", text: "Контакты и резюме диалога уходят менеджеру — клиенту не нужно повторять задачу." },
        ].map(({ icon: Icon, title, text }) => (
          <div key={title} className="rounded-xl border p-4">
            <Icon className="mb-2 size-5 text-brand" />
            <div className="font-medium">{title}</div>
            <p className="text-sm text-muted-foreground">{text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
