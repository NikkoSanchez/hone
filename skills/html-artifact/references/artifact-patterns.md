# HTML Artifact Patterns

Sources:
- https://thariqs.github.io/html-effectiveness/
- https://github.com/thariqs/html-effectiveness
- https://thariqs.github.io/html-effectiveness/unknowns/

The source gallery demonstrates single-file HTML pages as browser-native replacements for dense markdown. Use these patterns as recipes, not as text to copy.

## Selection Heuristic

Choose HTML when the user needs to:

- Compare multiple directions side by side.
- Inspect code, diffs, module structure, or risk spatially.
- Review visual design, components, motion, or interaction.
- Understand a concept through controls, diagrams, or live examples.
- Present recurring status, incident, or PR material with consistent structure.
- Manipulate a temporary domain-specific editor and export the result.
- Discover unknowns before, during, or after implementation.

Stay in markdown when the answer is short, mostly textual, or primarily conversational.

## Core Patterns

| Task family | Artifact shape | Include | Good fit |
| --- | --- | --- | --- |
| Exploration and planning | Side-by-side option matrix, visual direction board, or implementation plan | Tradeoff cards, recommendation, timeline, risks, data flow, alternatives | "Show me approaches", "compare designs", "turn this into a plan" |
| Code review and understanding | Annotated diff, PR writeup, module map | File nav, severity labels, callouts linked to lines, hot path diagram, reviewer focus list | PR reviews, unfamiliar packages, architecture walkthroughs |
| Design | Living design sheet or component contact sheet | Tokens, swatches, type scale, states, sizes, copyable CSS values | Design system audits, button/input variants, visual QA |
| Prototyping | Animation sandbox or clickable flow | Real controls, timing sliders, stateful screens, reset buttons | Motion tuning, workflow feel, pre-build interaction checks |
| Diagrams | Inline SVG figure sheet or annotated flowchart | Vector figures, labels, clickable details, failure paths, timings | Blog diagrams, process maps, deployment flows |
| Decks | Arrow-key HTML slide deck | One section per slide, keyboard nav, progress indicator, speaker-friendly pacing | Meeting readouts from docs, threads, or plans |
| Research and learning | Interactive explainer | TLDR, tabs, collapsible details, glossary, live model, comparison table | Repo feature explanations, technical concepts, onboarding |
| Reports | Status report, postmortem, or incident timeline | Summary cards, timeline, chart, blockers, decisions, follow-up checklist | Weekly updates, launch reviews, incident analysis |
| Custom editors | Throwaway editor with export | Domain-specific controls, validation hints, copy markdown/diff/prompt button | Ticket triage, feature flags, prompt tuning, prioritization |

## Unknowns Patterns

Use these when the work is ambiguous or the user is not sure what to ask for yet.

| Phase | Artifact shape | Include |
| --- | --- | --- |
| Before implementation | Blindspot pass | Unknowns grouped by area, evidence, risk, and a copyable improved prompt |
| Before implementation | Teach-me explainer | Vocabulary ladder, live examples, before/after controls, prompt language the user can reuse |
| Before implementation | Multiple design directions | Contrasting alternatives with "steal" and "skip" chips that assemble feedback |
| Before implementation | Mock before wiring | Clickable mock, A/B questions, and a response template for decisions |
| Before implementation | Brainstorm map | Options plotted by effort, impact, confidence, and time horizon |
| Before implementation | Interview artifact | One-question-at-a-time flow, decisions table, generated implementation prompt |
| Before implementation | Reference port map | Matched source excerpts, semantic mapping, gotchas, edge-case table |
| Before implementation | Tweakable plan | Plan organized by likely changes, with alternatives exposed before mechanical steps |
| During implementation | Implementation notes | Deviations from the plan, conservative calls made, and lessons for attempt two |
| After implementation | Buy-in doc | Demo, objections answered with evidence, sign-off list, remaining risk |
| After implementation | Merge-readiness quiz | Change summary, focused questions, links back to sections the user skimmed |

## Construction Notes

- Put the main decision or artifact title at the top, followed by the interactive or visual core.
- Make navigation local: sticky table of contents, tabs, section jump links, or a file list when the page is long.
- Use color as secondary information. Pair it with text labels such as "blocking", "watch", "safe", "unknown", or "recommended".
- For code and diffs, keep line numbers visible and callouts close to the referenced line.
- For comparisons, make dimensions explicit: effort, risk, reversibility, time, confidence, performance, cost, accessibility, maintenance, or user impact.
- For editors, end with an export/copy button that produces markdown, JSON, a diff, or a prompt the user can paste back into Codex.
- For generated facts, include a small assumptions/provenance section. For codebase facts, cite file paths and commands.
