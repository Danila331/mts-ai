"use client";

import { Mail, MessageSquareWarning, Scale, Sparkles } from "lucide-react";
import { useState } from "react";
import { AppShell, PageBar } from "@/components/app-shell";
import { DemoBanner, ManagerTabs } from "@/components/manager/manager-chrome";
import { ChatView } from "@/components/chat/chat-view";
import type { Starter } from "@/components/chat/starters";
import { ChunkSheet } from "@/components/kb/chunk-sheet";
import { SessionsList } from "@/components/sessions-sidebar";
import { useChat } from "@/hooks/use-chat";
import { useKb } from "@/hooks/use-kb";

// Три сценария из T11: сравнение продуктов, письмо клиенту, ответ на возражение. Формулировки — свои.
const SCENARIOS: Starter[] = [
  {
    icon: Scale,
    label: "Сравни продукты",
    text: "Сравни платформу учёта и поиск коммерческих потерь: кому что предлагать и что нужно для старта?",
  },
  {
    icon: Mail,
    label: "Письмо клиенту",
    text: "Черновик письма директору склада, который спросил про солнечную станцию на крыше: что ответить по базе?",
  },
  {
    icon: MessageSquareWarning,
    label: "Ответ на возражение",
    text: "Клиент говорит: «у нас уже есть счётчики, зачем нам платформа учёта?» Как ответить?",
  },
];

/**
 * «Спросить базу» для регионального менеджера МТС: та же база знаний и те же источники, но ответ — коллеге
 * («коротко / детали / источники», до 150 слов), а не клиенту. Разговоры — свои, отдельно от стенда.
 */
export function Copilot() {
  const chat = useChat("eb.copilot.sessions.v1", "copilot");
  const { kb } = useKb();
  const [chunk, setChunk] = useState<string | null>(null);
  const [line, setLine] = useState<number | undefined>();
  const openChunk = (id: string, hl?: number) => {
    setChunk(id);
    setLine(hl);
  };

  return (
    <AppShell onNew={() => chat.create()} sidebar={chat.ready ? <SessionsList chat={chat} query="" /> : null}>
      <PageBar icon={Sparkles} title="Менеджер" subtitle="спросить базу знаний" />
      <ManagerTabs />
      <DemoBanner />
      <div className="min-h-0 flex-1">
        {chat.ready && (
          <ChatView
            chat={chat}
            kb={kb}
            onOpenChunk={openChunk}
            heading="Что подготовить к клиенту?"
            greeting="Для менеджеров МТС: сравнение продуктов, черновик письма, ответ на возражение — только по базе знаний EnergyTool, с источниками."
            placeholder="Спросите базу: сравнение, письмо клиенту, возражение…"
            starters={SCENARIOS}
          />
        )}
      </div>
      <ChunkSheet kb={kb} chunkId={chunk} line={line} onClose={() => setChunk(null)} />
    </AppShell>
  );
}
