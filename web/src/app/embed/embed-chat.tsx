"use client";

import { ArrowLeft, Headset, SquarePen, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChatView } from "@/components/chat/chat-view";
import { LeadPanel } from "@/components/chat/lead-dialog";
import { NewDialogConfirm } from "@/components/chat/new-dialog-confirm";
import { BotAvatar } from "@/components/chat/message-item";
import { topicByName } from "@/components/chat/topics";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChat } from "@/hooks/use-chat";
import { AI_DISCLAIMER, AI_LABEL, hasUnsentLead } from "@/lib/answer-ux";
import { FLOWS } from "@/lib/wizards/flows";
import { kbHref, useKb } from "@/hooks/use-kb";
import { MAX_MESSAGE, messageLength } from "@/lib/document-text";
import { isTrustedMessage, resolveParent } from "@/lib/embed-origin";
import { type PageInfo, isTopicName, sanitizePage } from "@/lib/page-context";
import { parseStreamFlag } from "@/lib/stream-text";
import { cn } from "@/lib/utils";

const HEX = /^#[0-9a-f]{3,8}$/i;
const NO_ORIGINS: string[] = [];

/**
 * Чат внутри iframe виджета. Общается со страницей-хозяином через postMessage. Origin хозяина берётся из ?parent=,
 * но принимается, только если он есть в EB_EMBED_ALLOWED_ORIGINS (allowedOrigins) и совпадает с настоящим хозяином
 * окна, где браузер его сообщает (T35, resolveParent). Отправка — на этот точный origin, приём — только от него и только
 * от window.parent (isTrustedMessage).
 * Страница сайта (путь, заголовок, UTM) приходит сообщением eb:page и уходит с вопросами в сессию — для
 * аналитики, не в промпт. Тема страницы (?topic= или eb:page) меняет приветствие и стартовые вопросы.
 * Потоковая выдача (T13) — по умолчанию включена; data-stream="0" сайта приходит как ?stream=0 и полем stream
 * в eb:page: тогда ответ показывается целиком, уже после проверки.
 */
export function EmbedChat({ allowedOrigins = NO_ORIGINS }: { allowedOrigins?: string[] }) {
  const params = useSearchParams();
  const title = params.get("title") || "Консультант EnergyTool";
  const subtitle = params.get("subtitle") || "Отвечает по базе знаний МТС";
  const color = HEX.test(params.get("color") ?? "") ? params.get("color")! : undefined;
  const parentParam = params.get("parent");
  const [embedded, setEmbedded] = useState(false);
  // Доверенный origin хозяина; null — хозяин не прошёл проверку, сообщений ему не шлём и от него не принимаем.
  const [parent, setParent] = useState<string | null>(null);
  const [page, setPage] = useState<PageInfo | undefined>();
  // undefined — тему ещё не присылали сообщением, берём из адреса; null — страница без темы.
  const [pageTopic, setPageTopic] = useState<string | null | undefined>();
  const topicName = pageTopic === undefined ? params.get("topic") : pageTopic;
  const topic = topicByName(topicName);
  // У темы своё приветствие; без темы — из data-greeting сайта или общее.
  const greeting = topic?.greeting ?? (params.get("greeting") || undefined);
  // undefined — флаг сообщением не приходил, берём из адреса; без него — печатаем.
  const [pageStream, setPageStream] = useState<boolean | undefined>();
  const stream = pageStream ?? parseStreamFlag(params.get("stream")) ?? true;

  const chat = useChat("eb.widget.sessions.v1", "chat", { channel: "embed", page, stream });
  const { kb } = useKb();
  const [leadOpen, setLeadOpen] = useState(false);
  // «Новый диалог» (T31): если в этом диалоге есть начатая, но не отправленная заявка — сначала спрашиваем.
  const [confirmNew, setConfirmNew] = useState(false);
  const requestNew = () => (hasUnsentLead(chat.active) ? setConfirmNew(true) : chat.create());
  const sendRef = useRef(chat.send);
  const pending = useRef<string[]>([]);

  useEffect(() => {
    sendRef.current = chat.send;
  });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- window доступен только после монтирования
    setEmbedded(window.parent !== window);
    // ancestorOrigins есть в Chrome и Safari; в Firefox проверка опирается на allowlist и frame-ancestors.
    const ancestor = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins?.[0];
    setParent(resolveParent(parentParam, allowedOrigins, ancestor, window.location.origin));
  }, [parentParam, allowedOrigins]);

  // Вопросы, пришедшие до загрузки истории, отправляем, как только чат готов.
  useEffect(() => {
    if (!chat.ready || !pending.current.length) return;
    for (const q of pending.current.splice(0)) sendRef.current(q);
  }, [chat.ready]);

  const notify = (type: string) => {
    if (embedded && parent) window.parent.postMessage({ type }, parent);
  };

  useEffect(() => {
    if (!embedded || !parent) return;
    const onMessage = (e: MessageEvent) => {
      if (!isTrustedMessage(e, parent, window.parent)) return;
      const data = e.data as { type?: string; text?: unknown };
      if (data?.type === "eb:ask" && typeof data.text === "string" && data.text.trim()) {
        // Вопрос от страницы тоже ограничен длиной реплики: сервер подрезал бы остальное молча.
        const text = data.text.trim();
        if (messageLength(text) > MAX_MESSAGE) return;
        if (chat.ready) sendRef.current(text);
        else pending.current.push(text);
      } else if (data?.type === "eb:open") {
        document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      } else if (data?.type === "eb:page") {
        // Сообщению не верим на слово: только известные поля, строки и пределы сервера.
        const { page: raw, topic: next, stream: flag } = data as { page?: unknown; topic?: unknown; stream?: unknown };
        const clean = sanitizePage(raw);
        setPage(Object.keys(clean).length ? clean : undefined);
        setPageTopic(isTopicName(next) ? next : null);
        // Только true/false: старый загрузчик без поля оставляет флаг из адреса.
        if (typeof flag === "boolean") setPageStream(flag);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && window.parent.postMessage({ type: "eb:close" }, parent);
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKey);
    window.parent.postMessage({ type: "eb:ready" }, parent);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKey);
    };
  }, [embedded, parent, chat.ready]);

  // Новый ответ, пока виджет закрыт, — точка на кнопке.
  const answers = chat.active?.messages.filter((m) => m.role === "assistant" && m.answer).length ?? 0;
  const seen = useRef(answers);
  useEffect(() => {
    if (answers > seen.current) notify("eb:unread");
    seen.current = answers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers]);

  const style = color
    ? ({
        "--brand": color,
        "--primary": color,
        "--brand-text": color,
      } as React.CSSProperties)
    : undefined;

  const headerButton =
    "flex size-8 max-sm:size-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [&_svg]:size-[18px]";

  return (
    <div className="flex h-dvh flex-col bg-background" style={style}>
      <header className="flex h-16 shrink-0 items-center gap-3 border-b px-4">
        {leadOpen ? (
          <>
            <button
              type="button"
              onClick={() => setLeadOpen(false)}
              className={cn(headerButton, "-ml-1.5")}
              aria-label="Назад к чату"
            >
              <ArrowLeft />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] leading-tight font-semibold">Передать запрос менеджеру</div>
              <div className="mt-1 truncate text-xs text-muted-foreground">Менеджер МТС EnergyTool получит резюме разговора</div>
            </div>
          </>
        ) : (
          <>
            <BotAvatar className="size-9" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] leading-tight font-semibold">{title}</div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="relative flex size-1.5 shrink-0">
                  <span className="absolute inset-0 animate-ping rounded-full bg-success motion-reduce:hidden" />
                  <span className="relative size-1.5 rounded-full bg-success" />
                </span>
                <span className="truncate">
                  <span className="font-medium text-foreground/70">{AI_LABEL}</span> · {subtitle}
                </span>
              </div>
            </div>
          </>
        )}
        <div className="-mr-1.5 flex items-center">
          {!leadOpen && (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => setLeadOpen(true)}
                      className={headerButton}
                      aria-label="Связаться с менеджером"
                    />
                  }
                >
                  <Headset />
                </TooltipTrigger>
                <TooltipContent>Связаться с менеджером</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button type="button" onClick={requestNew} className={headerButton} aria-label="Новый диалог" />
                  }
                >
                  <SquarePen />
                </TooltipTrigger>
                <TooltipContent>Новый диалог</TooltipContent>
              </Tooltip>
            </>
          )}
          {embedded && (
            <button type="button" onClick={() => notify("eb:close")} className={headerButton} aria-label="Свернуть">
              <X />
            </button>
          )}
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        {chat.ready && (
          <div className={cn("h-full", leadOpen && "invisible")} aria-hidden={leadOpen}>
            <ChatView
              chat={chat}
              kb={kb}
              compact
              greeting={greeting}
              starters={topic?.starters}
              onOpenChunk={(id) => window.open(kbHref(id), "_blank", "noopener")}
              onLead={() => setLeadOpen(true)}
              summary
              wizards={FLOWS}
              showRoles
              showLevel
            />
          </div>
        )}
        {leadOpen && chat.active && (
          <div className="msg-in absolute inset-0 bg-background">
            <LeadPanel session={chat.active} onDone={(l) => chat.setLead(l)} onClose={() => setLeadOpen(false)} />
          </div>
        )}
      </div>
      {!leadOpen && (
        <div className="shrink-0 px-4 pb-2.5 text-center text-[11px] leading-snug text-muted-foreground">
          {AI_DISCLAIMER} Цифры по вашему объекту подтвердит специалист МТС
        </div>
      )}
      <NewDialogConfirm
        open={confirmNew}
        onCancel={() => setConfirmNew(false)}
        onConfirm={() => {
          setConfirmNew(false);
          chat.create();
        }}
      />
    </div>
  );
}
