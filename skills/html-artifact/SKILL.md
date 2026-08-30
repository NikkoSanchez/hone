---
name: html-artifact
description: >-
  Create standalone, self-contained HTML artifacts for work that is easier to inspect visually or interactively than to read as markdown: comparisons, implementation plans, annotated code reviews, module maps, design system sheets, prototypes, diagrams, slide decks, explainers, reports, incident timelines, custom editors, blindspot discovery, and review or buy-in docs. Use when the user asks for an HTML artifact, interactive report, demo, explainer, visual comparison, browser-viewable document, or when an answer would benefit from spatial layout, controls, charts, inline SVG, copy/export buttons, or browser-based review.
---

# HTML Artifact

## Overview

Create a single `.html` file that turns dense reasoning, code context, design context, or planning material into something the user can inspect in a browser. Favor HTML when layout, interaction, comparison, animation, diagrams, or copyable outputs make the work easier to evaluate than a linear markdown answer.

## Workflow

1. Decide whether HTML earns its keep. Use it for spatial, visual, comparative, interactive, recurring, or reviewer-facing material. Use ordinary markdown for short answers, simple checklists, and cases where a browser artifact would add ceremony.
2. Pick the artifact pattern. Read `references/artifact-patterns.md` when choosing among comparison sheets, review maps, design sheets, prototypes, explainers, reports, custom editors, or unknowns-discovery artifacts.
3. Gather the minimum source material needed: code, diffs, screenshots, data, product constraints, user goals, and the intended audience. Mark uncertain claims inside the artifact instead of smoothing over them.
4. Build one self-contained file. Inline CSS, JavaScript, and SVG. Do not depend on a build step, package install, CDN, web font, remote image, or remote data fetch unless the user explicitly asks for it.
5. Use Catppuccin Latte and Catppuccin Mocha as the two color themes unless the user explicitly requests a different visual system. Follow the official [palette](https://catppuccin.com/palette/) and [style guide](https://github.com/catppuccin/catppuccin/blob/main/docs/style-guide.md): Base for the main background; Mantle and Crust for secondary panes; Surface 0–2 for raised elements and controls; Text/Subtext/Overlay for their named typography roles; Blue for actions, links, tags, and pills; Lavender for active or focus borders; Green, Yellow, and Red for status; and Base for text on filled accents. Include a visible theme toggle, default from `prefers-color-scheme`, and persist the user's choice in local storage. Use `assets/base-artifact.html` as the canonical palette and toggle implementation.
6. Start from `assets/base-artifact.html` when helpful, then reshape the layout to the task. The template is scaffolding, not a layout that every artifact must preserve; its Catppuccin theme behavior is the default visual foundation.
7. Save the result as a `.html` file in the requested location. If no location is requested, save artifacts in `/Users/nikkolassanchez/Dev/html-artifacts` with an obvious, hyphen-case filename.
8. Verify the file by opening it in a browser. For complex layout or interaction, use Playwright screenshots or direct browser testing to confirm the page is nonblank, readable, responsive, both themes render correctly, and the controls work.
9. Final response: link the HTML file, summarize what it contains, and mention any validation or browser checks performed.

## Artifact Standards

- Make the artifact useful before making it decorative. The visual structure should reveal relationships, priorities, states, timelines, risk, tradeoffs, or decisions.
- Put the user's real subject matter in the first viewport. Avoid generic landing-page framing.
- Use semantic HTML, readable contrast, responsive layout, and keyboard-friendly controls.
- Prefer native controls: buttons for actions, tabs for alternate views, checkboxes/toggles for inclusion, sliders or numeric inputs for tuning, tables for dense comparisons, and `<details>` for optional depth.
- Add copy/export affordances for custom editors, prompt tuners, planning boards, feature flag editors, or artifacts meant to feed the next Codex prompt.
- Include provenance inside the artifact when it relies on sources, code paths, commands, dates, or assumptions.
- Keep all claims inspectable. Use "assumption", "needs verification", or "unknown" labels where source material is incomplete.
- Make print and screenshot output reasonable: avoid hidden critical information, tiny type, hover-only content, and controls that obscure content.

## Verification

Check the generated artifact before handing it to the user:

- The file has a `.html` extension and opens directly in a browser.
- CSS, JavaScript, and SVG are inline unless the user explicitly requested external assets.
- The document includes a title, viewport meta tag, readable first viewport, and responsive layout.
- Interactive controls work with mouse and keyboard where practical.
- Important content is visible without hover-only affordances.
- Source paths, assumptions, dates, and commands are shown when the artifact depends on them.

## Resources

- `references/artifact-patterns.md`: Read when selecting an artifact shape or adapting the article's examples to a new task.
- `assets/base-artifact.html`: Copy when a minimal, self-contained starter page is useful.
