"use client";

import { useEffect, useState } from "react";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Сочетание клавиш: ⌘ на Mac, Ctrl на остальных. */
export function Shortcut({ keys, className }: { keys: string[]; className?: string }) {
  const [mac, setMac] = useState(true);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- платформа известна только в браузере
  useEffect(() => setMac(isMac()), []);
  return (
    <KbdGroup className={cn("gap-0.5", className)}>
      {keys.map((k) => (
        <Kbd
          key={k}
          className="h-[18px] min-w-[16px] rounded-[4px] bg-transparent px-0.5 font-sans text-[11px] font-normal text-muted-foreground"
        >
          {k === "mod" ? (mac ? "⌘" : "Ctrl") : k === "shift" ? (mac ? "⇧" : "Shift") : k}
        </Kbd>
      ))}
    </KbdGroup>
  );
}

