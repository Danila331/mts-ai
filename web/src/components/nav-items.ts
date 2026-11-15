import { BookOpen, Code2, MessageSquare, Monitor, Moon, SlidersHorizontal, Sun } from "lucide-react";

/** Разделы стенда — в сайдбаре и в палитре ⌘K. */
export const NAV = [
  { href: "/playground", label: "Чат и отладка", icon: MessageSquare },
  { href: "/kb", label: "База знаний", icon: BookOpen },
  { href: "/widget", label: "Виджет для сайта", icon: Code2 },
  { href: "/settings", label: "Настройки RAG", icon: SlidersHorizontal },
];

export const THEMES = [
  { value: "light", label: "Светлая тема", icon: Sun },
  { value: "dark", label: "Тёмная тема", icon: Moon },
  { value: "system", label: "Тема как в системе", icon: Monitor },
] as const;

export const SESSIONS_KEY = "eb.playground.sessions.v1";
