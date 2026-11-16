"use client";

import { ArrowUp, FileText, Loader2, Mic, Paperclip, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useDictation } from "@/hooks/use-dictation";
import { getOcrInfo, readDocument } from "@/lib/api";
import { MAX_MESSAGE, acceptAttr, composeMessage, describeRead, fileType, messageLength } from "@/lib/document-text";
import { shrinkImage } from "@/lib/shrink-image";
import type { OcrInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Документ, приложенный к реплике: распознанный текст на проверку клиенту (T9). */
interface AttachedDocument {
  name: string;
  text: string;
  note: string;
}

const OCR_OFF_HINT =
  "Распознавание документов на этом стенде не подключено. Перепишите нужные данные из счёта или договора в сообщение.";

export function Composer({
  onSend,
  onStop,
  busy,
  disabled,
  compact,
  placeholder = "Опишите задачу: объект, что хотите посчитать или улучшить",
  autoFocus,
  value: external,
  tools,
}: {
  onSend: (text: string) => void;
  onStop?: () => void;
  busy?: boolean;
  disabled?: boolean;
  compact?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Подставить текст снаружи (например, вопрос из виджета). */
  value?: { text: string; nonce: number };
  /** Действия слева в нижней строке поля (например, «Передать менеджеру»). */
  tools?: React.ReactNode;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!external) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- подстановка текста по внешнему событию
    setText(external.text);
    ref.current?.focus();
  }, [external]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, compact ? 128 : 224)}px`;
    };
    fit();
    // В виджете чат грузится заранее в скрытом окне: пересчитываем высоту, когда поле получает настоящую ширину.
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, compact]);

  // Распознанная фраза дописывается в поле для проверки — сама не отправляется.
  const append = useCallback((spoken: string) => {
    setText((t) => (t.trim() ? `${t.replace(/\s+$/, "")} ${spoken}` : spoken));
    ref.current?.focus();
  }, []);
  const dictation = useDictation(append, (message) => toast.error(message));

  // Документ (T9): файл → текст на сервере → клиент проверяет и правит его здесь → уходит в чат вместе с
  // репликой только по «Отправить». Сам файл нигде не остаётся: ни здесь, ни на сервере.
  const [ocr, setOcr] = useState<OcrInfo | null>(null);
  const [doc, setDoc] = useState<AttachedDocument | null>(null);
  const [reading, setReading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const readAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    let alive = true;
    void getOcrInfo().then((info) => alive && setOcr(info));
    return () => {
      alive = false;
      readAbort.current?.abort();
    };
  }, []);

  const pickFile = () => {
    if (!ocr?.enabled) {
      toast.info(OCR_OFF_HINT);
      return;
    }
    fileRef.current?.click();
  };

  const attach = async (file: File) => {
    if (!ocr) return;
    const type = fileType(file);
    if (!ocr.types.includes(type)) {
      toast.error("Поддерживаются фото JPG, PNG, WebP и PDF");
      return;
    }
    const controller = new AbortController();
    readAbort.current?.abort();
    readAbort.current = controller;
    setReading(true);
    try {
      const upload = await shrinkImage(file, type);
      if (upload.blob.size > ocr.max_bytes) {
        throw new Error(`Файл больше ${Math.floor(ocr.max_bytes / (1 << 20))} МБ — уменьшите его или приложите нужные страницы`);
      }
      const result = await readDocument(upload.blob, upload.type, controller.signal);
      setDoc({ name: file.name, text: result.text, note: describeRead(result) });
    } catch (e) {
      if (!controller.signal.aborted) toast.error(e instanceof Error ? e.message : "Не удалось распознать документ");
    } finally {
      if (readAbort.current === controller) {
        readAbort.current = null;
        setReading(false);
      }
    }
  };

  const dropDocument = () => {
    readAbort.current?.abort();
    readAbort.current = null;
    setReading(false);
    setDoc(null);
    ref.current?.focus();
  };

  const message = composeMessage(text, doc?.text);
  const overflow = messageLength(message) - MAX_MESSAGE;
  const ready = !busy && !disabled && !reading && !!message && overflow <= 0;
  // Нижняя строка с инструментами: всегда на стенде, в виджете — когда есть что показать слева.
  const stacked = !compact || !!tools;
  const submit = () => {
    if (!ready) return;
    onSend(message);
    setText("");
    setDoc(null);
  };

  const action = busy ? (
    <button
      type="button"
      onClick={onStop}
      aria-label="Остановить ответ"
      className="flex size-8 max-sm:size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-85 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <Square className="size-2.5 fill-current" />
    </button>
  ) : (
    <button
      type="button"
      onClick={submit}
      disabled={!ready}
      aria-label="Отправить"
      className={cn(
        "flex size-8 max-sm:size-11 shrink-0 items-center justify-center rounded-full transition-[background-color,color,transform] duration-150 focus-visible:ring-3 focus-visible:ring-brand/30 focus-visible:outline-none active:scale-95",
        ready
          ? "bg-brand text-brand-foreground hover:bg-[color-mix(in_oklch,var(--brand),black_10%)]"
          : "cursor-default bg-muted text-muted-foreground/60 dark:bg-accent",
      )}
    >
      <ArrowUp className="size-4" strokeWidth={2.5} />
    </button>
  );

  // Пока неизвестно, что принимает API (или он недоступен), кнопки нет. Без vision-модели она видна, но
  // неактивна: по нажатию — подсказка, что делать вместо.
  const attachButton = ocr?.types.length ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        pickFile();
      }}
      disabled={disabled || reading}
      aria-disabled={!ocr.enabled}
      aria-label={ocr.enabled ? "Приложить документ" : "Приложить документ — распознавание не подключено"}
      title={
        ocr.enabled
          ? `Приложить счёт или договор: фото (JPG, PNG, WebP) или PDF до ${Math.floor(ocr.max_bytes / (1 << 20))} МБ. Текст появится для проверки, файл не сохраняется`
          : OCR_OFF_HINT
      }
      className={cn(
        "flex size-8 max-sm:size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50",
        ocr.enabled ? "hover:bg-muted hover:text-foreground" : "cursor-help opacity-45",
      )}
    >
      {reading ? <Loader2 className="size-[18px] animate-spin" /> : <Paperclip className="size-[18px]" />}
    </button>
  ) : null;
  const fileInput = ocr?.enabled ? (
    <input
      ref={fileRef}
      type="file"
      hidden
      accept={acceptAttr(ocr.types)}
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) void attach(file);
      }}
    />
  ) : null;

  // Распознанный текст — до отправки: клиент видит, что именно уйдёт консультанту, и правит ошибки распознавания.
  const docPanel =
    doc || reading ? (
      <div className={cn("mb-2 rounded-[18px] border bg-surface p-2.5", compact ? "text-[13px]" : "text-sm")}>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <FileText className="size-3.5 shrink-0 text-brand-text" />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
            {reading ? "Распознаю документ…" : doc?.name}
          </span>
          <button
            type="button"
            onClick={dropDocument}
            aria-label={reading ? "Отменить распознавание" : "Убрать документ"}
            className="flex size-6 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <X className="size-3.5" />
          </button>
        </div>
        {doc && (
          <>
            <textarea
              value={doc.text}
              onChange={(e) => setDoc({ ...doc, text: e.target.value })}
              aria-label="Текст из документа — проверьте перед отправкой"
              rows={compact ? 4 : 6}
              className="mt-2 block max-h-56 w-full resize-y rounded-xl border border-input/70 bg-background px-3 py-2 font-mono text-[12.5px] leading-relaxed outline-none focus:border-ring/70"
            />
            <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
              Проверьте и поправьте текст — он уйдёт консультанту вместе с сообщением как данные из документа. Файл не
              сохраняется.{doc.note ? ` ${doc.note[0].toUpperCase()}${doc.note.slice(1)}.` : ""}
            </p>
            {overflow > 0 && (
              <p className="mt-1 text-[11.5px] font-medium text-destructive">
                Слишком длинно для одного сообщения: сократите текст на {overflow} зн.
              </p>
            )}
          </>
        )}
      </div>
    ) : null;

  // Без Web Speech API в браузере кнопки нет вовсе.
  const mic = dictation.supported ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        dictation.toggle();
      }}
      disabled={disabled}
      aria-pressed={dictation.listening}
      aria-label={dictation.listening ? "Остановить диктовку" : "Надиктовать сообщение"}
      title={dictation.listening ? "Слушаю — нажмите, чтобы закончить" : "Надиктовать: текст появится в поле, отправите сами"}
      className={cn(
        "flex size-8 max-sm:size-11 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50",
        dictation.listening
          ? "bg-brand-soft text-brand-text motion-safe:animate-pulse"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Mic className="size-[18px]" />
    </button>
  ) : null;

  return (
    <div>
      {docPanel}
      {fileInput}
      <div
        onClick={() => ref.current?.focus()}
        className={cn(
          "cursor-text border border-input bg-background shadow-[var(--shadow-float)] transition-[border-color,box-shadow] focus-within:border-ring dark:bg-card",
          stacked ? "rounded-[20px] p-2" : "flex items-end gap-2 rounded-[20px] py-1.5 pr-1.5 pl-4",
          compact && stacked && "rounded-[16px] p-1.5",
        )}
      >
        <textarea
          ref={ref}
          value={text}
          rows={1}
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          aria-label="Сообщение консультанту"
          className={cn(
            "block w-full resize-none bg-transparent leading-relaxed outline-none placeholder:text-muted-foreground",
            stacked
              ? cn("px-2.5 pt-1.5", compact ? "min-h-9 text-[14px]" : "min-h-11 text-[15px]")
              : "min-h-9 flex-1 py-[7px] text-[14px]",
          )}
        />
        {!stacked ? (
          <>
            {attachButton}
            {mic}
            {action}
          </>
        ) : (
          <div className="flex min-h-8 items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1" onClick={(e) => e.stopPropagation()}>
              {tools ?? (
                <span className="hidden truncate pl-2.5 text-[12px] text-muted-foreground sm:block">
                  {dictation.listening
                    ? "Слушаю… текст появится в поле, отправите сами"
                    : doc
                      ? "Документ уйдёт вместе с сообщением — можно добавить вопрос"
                      : "Enter — отправить · Shift + Enter — новая строка"}
                </span>
              )}
            </div>
            {attachButton}
            {mic}
            {action}
          </div>
        )}
      </div>
    </div>
  );
}
