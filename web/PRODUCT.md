# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Hack&Change 2026 jury** (primary for `/playground` and `/kb`). They ask the bot questions and check that answers are grounded in the knowledge base: which sections search found, what reached the model, what each sentence relies on, and whether the check fired. They look at it on a laptop during the demo.
- **MTS EnergyTool clients** (primary for `/embed` and the widget on energytool.mts.ru): businesses, SNT associations and plants that want to cut electricity costs, set up metering, or understand whether solar generation pays off. They ask in their own words and can hand the request to a manager.
- **Project developers**: use `/widget` as the embed snippet reference and `/playground` for debugging.

## Product Purpose

An AI consultant for MTS EnergyTool that answers only from the knowledge base (`knowledge-base/`), shows where every fact comes from, and embeds on any site with a single `<script>`. Success: the jury trusts the answers in seconds (sources and debugging are right there), and the client gets a short, accurate answer plus a clear path to a specialist.

## Positioning

Not a "chat with an LLM" but a consultant with verifiable grounding: numbered sources after sentences, the KB section the model saw opening in one click, and a full answer trace (search → context → prompt → check). The same core (`energybot/`) runs both the automated evaluation and the web chat.

## Operating Context

- Stand: Next.js 16 + shadcn/ui (base-ui), Go API `backend/` (answers from the Python core `scripts/core_api.py`) behind the `/api/*` proxy. Sessions are stored in the browser's `localStorage`.
- Widget: `widget.js` (Shadow DOM launcher + iframe `/embed`) on a third-party site; the host page is light.
- "Autocheck" mode reproduces the evaluation platform: the bot does not offer to leave a request.

## Capabilities and Constraints

- Screens: `/playground` (sessions, chat, answer debugging: Grounding, Search, Context, Prompt, Check, JSON), `/kb` (KB tree, document split into sections the way the model sees them, `?chunk=` links), `/widget` (snippet, settings, live preview, JS API), `/embed` (compact chat in an iframe).
- Lead handoff: name, phone, company, comment + an LLM-written conversation summary; test data only.
- Facts about products and numbers come only from the KB; the UI must not invent claims.
- The KB repository is private; materials from the case brief are not published.

## Brand Commitments

- MTS partner style: red accent `#FF0032`, graphite `#1D2023`, cool-gray neutrals. The proprietary MTS logo and font are not reproduced.
- The shadcn/ui library is kept (user decision).
- Light and dark themes with a switcher (user decision); the widget on the client's site stays light.
- Craft and interaction-model reference: the Claude and ChatGPT apps (user decision).

## Evidence on Hand

- The real KB and real bot answers via the API; demo questions in `demo_questions.csv` (not copied into the UI).
- No reviews, client logos or metrics — the UI must not show them.

## Product Principles

1. Grounding is visible: every answer links to KB sections in one action.
2. The conversation comes first, tools sit nearby: debugging doesn't crowd the chat but is always one click away.
3. Honesty over persuasion: the bot says what it doesn't know and offers a specialist.
4. Embeds without friction: the widget never breaks the host site and never depends on its styles.

## Accessibility & Inclusion

The interface is in Russian. Contrast for text and controls meets WCAG AA in both themes; keyboard access to the chat, dialogs and debug tabs; respects `prefers-reduced-motion`.
