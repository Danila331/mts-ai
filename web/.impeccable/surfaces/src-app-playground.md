---
version: 1
slug: "src-app-playground"
primary_target: "src/app/playground"
related_targets: ["src/app/kb","src/app/widget","src/app/embed"]
---

# Surface: web stand and widget (playground, kb, widget, embed, lead dialog)

Mode: Operate (playground, embed, widget), Read (kb).
Audience and task: the jury checks the grounding of answers; the client asks a question and hands the request to a manager.
Constraints: shadcn/ui (base-ui), light/dark themes with a switcher, the widget on the host site stays light, MTS red accent.

## Direction contract

THESIS: Conversation first, as in the Claude/ChatGPT apps: one sidebar for navigation and history, a wide centered conversation column, and tools (debugging) in an adjacent panel. Rejects the default "top header + three equal columns + cards inside cards".

OWN-WORLD: Graphite and cool-gray MTS neutrals, white/graphite ground, a single red #FF0032 only for action and grounding (send, primary action, source numbers, active selection). Onest for all text, JetBrains Mono only for ids, the prompt and JSON. Hairline borders, 10/16/24 px radii, no shadow except on overlays and the composer.

STORY: The visitor sees an empty chat with a greeting and the composer in the center, picks a question, gets an answer with numbered sources, clicks a number and lands on the exact KB section, and opens the trace in the side panel.

FIRST VIEWPORT: Left, a 260 px sidebar: wordmark, "New conversation", nav (Chat, Knowledge base, Widget), conversation history, footer with API status and theme switcher. Center: a 48 px bar with the conversation title, Autocheck switch, export and debug toggle; a 720 px column; the composer is a large 24 px pill with a red round send button, centered in the empty state and pinned to the bottom during a conversation. Right: the debug panel with underline tabs. Below 1024 px the sidebar and debug panel become sheets.

FORM: pinned direction, signature move: red numbered sources after sentences + a "Sources" row under the answer, each one opening the KB section in one click.
seed: none (pinned) — "Most of all I like the Claude and ChatGPT design, it would fit here perfectly … we stay on the shadcn UI library … the red accent color is MTS style"

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
