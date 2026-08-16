import { FileDiff, parsePatchFiles } from "@pierre/diffs";

type AgentStatus = "listening" | "working" | "offline";

interface CodeReviewFinding {
  id: string;
  file: string;
  line?: number;
  side?: "deletions" | "additions";
  severity: "info" | "warning" | "error";
  title: string;
  body: string;
}

interface CodeReview {
  patch: string;
  findings: CodeReviewFinding[];
  summary?: string;
  source?: string;
  createdAt: string;
}

interface ArtifactOption {
  id: string;
  name: string;
  filePath: string;
  url: string;
  active: boolean;
  revision: number;
  hasReview: boolean;
}

interface TargetRef {
  anchor: string;
  label?: string;
  quote?: string;
  contextHash?: string;
  startOffset?: number;
  endOffset?: number;
}

interface FeedbackItem {
  id?: string;
  target: TargetRef;
  body: string;
  queueKey?: string;
  tag?: string;
  createdAt?: string;
}

interface HistoryMessage {
  id: string;
  role: "user" | "agent" | "system";
  body: string;
  createdAt: string;
}

interface SessionSnapshot {
  id: string;
  filePath: string;
  artifactRevision: number;
  queue: FeedbackItem[];
  history: HistoryMessage[];
  agentStatus: AgentStatus;
  updatedAt: string;
  deliveryBatchId: string | null;
  artifactUrl: string;
  eventsUrl: string;
  feedbackUrl: string;
  statusUrl: string;
  reviewUrl: string;
  review?: CodeReview;
}

interface SelectedTarget extends TargetRef {
  element: Element;
}

const $ = <T extends Element>(selector: string): T | null => document.querySelector<T>(selector);
const $$ = <T extends Element>(selector: string): T[] => [...document.querySelectorAll<T>(selector)];

const frame = $("#artifactFrame") as HTMLIFrameElement;
const artifactLoading = $("#artifactLoading") as HTMLDivElement;
const feedbackBody = $("#feedbackBody") as HTMLTextAreaElement;
const queueList = $("#queueList") as HTMLDivElement;
const historyList = $("#historyList") as HTMLDivElement;
const sectionList = $("#sectionList") as HTMLElement;
const quotePreview = $("#quotePreview") as HTMLDivElement;
const toast = $("#toast") as HTMLDivElement;
const artifactSelect = $("#artifactSelect") as HTMLSelectElement;
const reviewStage = $("#reviewStage") as HTMLDivElement;
const diffList = $("#diffList") as HTMLDivElement;
const reviewList = $("#reviewList") as HTMLDivElement;

let session: SessionSnapshot;
let localQueue: FeedbackItem[] = [];
let diffInstances: FileDiff[] = [];
let selectedTarget: SelectedTarget | null = null;
let mode: "annotate" | "explore" = "annotate";
let toastTimer: number | undefined;
let ignoreNextArtifactClick = false;
let hoveredArtifactElement: Element | null = null;

function draftStorageKey(): string {
  return `hone:drafts:${session.id}`;
}

function saveDrafts(): void {
  localStorage.setItem(draftStorageKey(), JSON.stringify(localQueue));
}

function loadDrafts(): void {
  try {
    const value = JSON.parse(localStorage.getItem(draftStorageKey()) ?? "[]") as unknown;
    localQueue = Array.isArray(value) ? value as FeedbackItem[] : [];
  } catch {
    localQueue = [];
  }
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}

function showToast(message: string): void {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function statusLabel(status: AgentStatus): string {
  return status === "working" ? "Working" : status === "offline" ? "Offline" : "Listening";
}

function setStatusVisual(status: AgentStatus): void {
  const label = statusLabel(status);
  $("#agentStatus")!.textContent = label;
  $("#sidebarStatus")!.textContent = `Agent ${label.toLowerCase()}`;
  $("#sidebarStatusDetail")!.textContent = status === "working"
    ? "The agent is processing the latest envelope."
    : status === "offline"
      ? "Feedback stays queued until an agent starts polling."
      : "The agent can wait on the next long poll.";
  for (const dot of [$("#topStatusDot"), $("#sidebarStatusDot"), $("#railStatusDot")]) {
    dot?.classList.toggle("is-working", status === "working");
    dot?.classList.toggle("is-offline", status === "offline");
  }
}

function renderQueue(): void {
  const pending = session?.queue ?? [];
  const cards = [
    ...localQueue.map((item, index) => ({ item, source: "local" as const, index })),
    ...pending.map((item) => ({ item, source: "server" as const, index: -1 })),
  ];

  if (cards.length === 0) {
    queueList.innerHTML = `<div class="empty-state"><div><strong>No comments queued yet.</strong><br />Select a block or text range in the artifact, then add a comment.</div></div>`;
  } else {
    queueList.innerHTML = cards.map(({ item, source, index }) => `
      <article class="queue-card ${source === "server" ? "server-pending" : ""}">
        <div class="queue-meta"><strong>${escapeHtml(item.target.label ?? item.target.anchor)}</strong><span>${source === "local" ? "local" : "sent"}</span></div>
        ${item.target.quote ? `<span class="queue-quote">${escapeHtml(item.target.quote)}</span>` : ""}
        <p class="queue-body">${escapeHtml(item.body)}</p>
        <div class="queue-footer">
          <span class="tag ${source === "server" ? "server" : ""}">${escapeHtml(source === "server" ? "waiting for agent" : item.tag ?? "draft")}</span>
          <span class="queue-anchor mono">#${escapeHtml(item.target.anchor)}</span>
          ${source === "local" ? `<span class="queue-actions"><button type="button" data-action="up" data-index="${index}" aria-label="Move comment up">↑</button><button type="button" data-action="down" data-index="${index}" aria-label="Move comment down">↓</button><button type="button" data-action="edit" data-index="${index}">Edit</button><button type="button" data-action="remove" data-index="${index}" aria-label="Remove comment">×</button></span>` : ""}
        </div>
      </article>`).join("");
  }

  const count = localQueue.length + pending.length;
  $("#queueCount")!.textContent = String(count);
  $("#queueTabCount")!.textContent = String(count);
  $("#sidebarQueueCount")!.textContent = String(count);
  const hasDrafts = localQueue.length > 0;
  $("#sendQueue")!.toggleAttribute("disabled", !hasDrafts);
  $("#sendEnd")!.toggleAttribute("disabled", !hasDrafts);
}

function renderHistory(): void {
  const messages = session?.history ?? [];
  historyList.innerHTML = messages.length
    ? messages.map((message) => `<article class="history-card ${escapeHtml(message.role)}"><div class="message-meta"><strong>${escapeHtml(message.role === "agent" ? "Agent" : message.role === "user" ? "You" : "Hone")}</strong><span>${escapeHtml(formatTime(message.createdAt))}</span></div><p class="message-body">${escapeHtml(message.body)}</p></article>`).join("")
    : `<div class="empty-state">No delivered messages yet.</div>`;
}

function findingAnchor(finding: CodeReviewFinding): string {
  return `code:${finding.file}:${finding.side ?? "additions"}:${finding.line ?? 1}`;
}

function renderReviewFindings(): void {
  const findings = session.review?.findings ?? [];
  $("#reviewCount")!.textContent = String(findings.length);
  reviewList.innerHTML = findings.length
    ? findings.map((finding, index) => `
      <article class="finding-card ${escapeHtml(finding.severity)}">
        <span class="finding-location mono">${escapeHtml(finding.file)}${finding.line ? `:${finding.line}` : ""}</span>
        <strong>${escapeHtml(finding.title)}</strong>
        <p>${escapeHtml(finding.body)}</p>
        <div class="finding-actions"><button type="button" data-finding-action="locate" data-index="${index}">Show diff</button><button type="button" data-finding-action="queue" data-index="${index}">Discuss</button></div>
      </article>`).join("")
    : `<div class="empty-state">The review contains no structured findings.</div>`;
}

function renderCodeReview(): void {
  for (const instance of diffInstances) instance.cleanUp();
  diffInstances = [];
  diffList.replaceChildren();
  const review = session.review;
  if (!review) return;
  $("#reviewSummary")!.textContent = review.summary ?? "";
  const files = parsePatchFiles(review.patch, `hone-${session.id}`)
    .flatMap((patch) => patch.files);
  if (files.length === 0) {
    diffList.innerHTML = `<div class="diff-empty">No file diffs could be parsed from this patch.</div>`;
    return;
  }
  for (const file of files) {
    const container = document.createElement("div");
    container.className = "diff-file";
    container.dataset.file = file.name;
    diffList.appendChild(container);
    const instance = new FileDiff({
      diffStyle: "unified",
      overflow: "wrap",
      lineDiffType: "word",
      hunkSeparators: "line-info",
      lineHoverHighlight: "both",
      onLineClick: ({ lineNumber, annotationSide, lineElement }) => {
        showSelectedTarget({
          element: lineElement,
          anchor: `code:${file.name}:${annotationSide}:${lineNumber}`,
          label: `${file.name}:${lineNumber}`,
        });
        setView("queue");
      },
    });
    instance.render({ fileDiff: file, fileContainer: container });
    diffInstances.push(instance);
  }
}

function setSurface(surface: "artifact" | "review"): void {
  if (surface === "review" && !session.review) return;
  $(".artifact-stage")!.toggleAttribute("hidden", surface !== "artifact");
  reviewStage.toggleAttribute("hidden", surface !== "review");
  $$<HTMLButtonElement>("[data-surface]").forEach((button) => button.classList.toggle("is-active", button.dataset.surface === surface));
  $$<HTMLButtonElement>("[data-mode]").forEach((button) => button.toggleAttribute("hidden", surface === "review"));
  if (surface === "review") renderCodeReview();
}

function reviewMarkdown(): string {
  const review = session.review;
  if (!review) return "";
  const sections = review.findings.map((finding) => {
    const location = `${finding.file}${finding.line ? `:${finding.line}` : ""}`;
    return `### [${finding.severity.toUpperCase()}] ${finding.title}\n\n${finding.body}\n\n\`${location}\``;
  });
  return [`## Agent code review`, review.summary ?? "", ...sections].filter(Boolean).join("\n\n");
}

function render(): void {
  $("#sessionId")!.textContent = session.id;
  $("#revisionLabel")!.textContent = `rev ${session.artifactRevision}`;
  $("#artifactFile")!.textContent = session.filePath;
  setStatusVisual(session.agentStatus);
  renderQueue();
  renderHistory();
  const hasReview = Boolean(session.review);
  $("#reviewSurfaceButton")!.toggleAttribute("hidden", !hasReview);
  $("#reviewTab")!.toggleAttribute("hidden", !hasReview);
  renderReviewFindings();
}

async function sha256(value: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return "sha256:unavailable";
  }
}

function domPath(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current.tagName.toLowerCase() !== "body" && parts.length < 8) {
    const siblings = current.parentElement ? [...current.parentElement.children].filter((child) => child.tagName === current!.tagName) : [];
    const index = Math.max(0, siblings.indexOf(current) + 1);
    parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${index})`);
    current = current.parentElement;
  }
  return `path:${parts.join(">")}`;
}

function targetElementFromNode(node: EventTarget | Node | null, documentRef: Document): Element | null {
  // The artifact lives in an iframe, so its DOM objects come from a different
  // JavaScript realm. Cross-realm `instanceof Element/Node` checks are false;
  // use the DOM shape instead so annotation works in the embedded artifact.
  const candidate = node as (Element & { parentElement?: Element | null }) | null;
  const element = candidate && typeof candidate.closest === "function"
    ? candidate
    : candidate?.parentElement ?? null;
  if (!element || element === documentRef.body || element === documentRef.documentElement) return null;
  // Keep the target at the exact clicked/selected element. Explicit anchors on
  // ancestors remain useful for section navigation, but must not make every
  // nested annotation point at the same top-level review block.
  return element;
}

function targetFromElement(element: Element, quote = ""): Promise<SelectedTarget> {
  const anchor = element.getAttribute("data-anchor") || element.id || domPath(element);
  const label = element.getAttribute("data-label")
    || element.querySelector("h1, h2, h3, h4")?.textContent?.trim().replace(/\s+/g, " ")
    || element.tagName.toLowerCase();
  const context = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 900);
  return sha256(context).then((contextHash) => ({
    element,
    anchor,
    label: label.slice(0, 180),
    ...(quote ? { quote: quote.slice(0, 1200) } : {}),
    contextHash,
  }));
}

function markTarget(element: Element | null): void {
  const documentRef = frame.contentDocument;
  if (!documentRef) return;
  for (const marked of [...documentRef.querySelectorAll("[data-hone-target]")]) marked.removeAttribute("data-hone-target");
  element?.setAttribute("data-hone-target", "true");
}

function markHoveredTarget(element: Element | null): void {
  if (hoveredArtifactElement && hoveredArtifactElement !== element) {
    hoveredArtifactElement.removeAttribute("data-hone-hover");
  }
  hoveredArtifactElement = element;
  if (element && element !== selectedTarget?.element) {
    element.setAttribute("data-hone-hover", "true");
  }
}

function showSelectedTarget(target: SelectedTarget | null): void {
  selectedTarget = target;
  markTarget(target?.element ?? null);
  $("#targetLabel")!.textContent = target?.label ?? "No target selected";
  if (target?.quote) {
    quotePreview.hidden = false;
    quotePreview.textContent = target.quote;
  } else {
    quotePreview.hidden = true;
    quotePreview.textContent = "";
  }
}

function renderArtifactSections(documentRef: Document): void {
  const seen = new Set<string>();
  const sections = [...documentRef.querySelectorAll<HTMLElement>("[data-anchor]")]
    .map((element) => {
      const anchor = element.dataset.anchor?.trim() ?? "";
      const label = element.dataset.label?.trim()
        || element.querySelector("h1, h2, h3, h4")?.textContent?.trim().replace(/\s+/g, " ")
        || anchor;
      return { anchor, label };
    })
    .filter(({ anchor }) => Boolean(anchor) && !seen.has(anchor) && Boolean(seen.add(anchor)))
    .slice(0, 16);

  sectionList.innerHTML = sections.length
    ? sections.map(({ anchor, label }, index) => `<button type="button" data-anchor="${escapeHtml(anchor)}">${String(index + 1).padStart(2, "0")} <span>${escapeHtml(label)}</span></button>`).join("")
    : `<span class="section-list-empty">No artifact anchors found</span>`;
}

function installArtifactHooks(): void {
  const documentRef = frame.contentDocument;
  if (!documentRef) return;
  artifactLoading.classList.add("is-hidden");
  renderArtifactSections(documentRef);
  const style = documentRef.createElement("style");
  style.textContent = `[data-hone-hover]{outline:2px solid #f4c95d !important;outline-offset:3px !important;}[data-hone-target]{outline:2px solid #1eb9b0 !important;outline-offset:3px !important;}`;
  documentRef.head.appendChild(style);

  documentRef.addEventListener("mouseover", (event) => {
    if (mode !== "annotate") return;
    markHoveredTarget(targetElementFromNode(event.target, documentRef));
  }, true);

  documentRef.addEventListener("mouseout", (event) => {
    const relatedTarget = targetElementFromNode(event.relatedTarget, documentRef);
    if (relatedTarget === hoveredArtifactElement) return;
    markHoveredTarget(null);
  }, true);

  documentRef.addEventListener("click", (event) => {
    if (mode !== "annotate") return;
    if (ignoreNextArtifactClick) {
      ignoreNextArtifactClick = false;
      return;
    }
    const element = targetElementFromNode(event.target, documentRef);
    if (!element) return;
    event.preventDefault();
    event.stopPropagation();
    void targetFromElement(element).then(showSelectedTarget);
  }, true);

  documentRef.addEventListener("mouseup", () => {
    if (mode !== "annotate") return;
    const selection = documentRef.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) return;
    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const element = targetElementFromNode(range?.commonAncestorContainer ?? selection.anchorNode, documentRef);
    if (!element) return;
    ignoreNextArtifactClick = true;
    void targetFromElement(element, selection.toString().trim()).then((target) => {
      target.startOffset = range?.startOffset ?? selection.anchorOffset;
      target.endOffset = range?.endOffset ?? selection.focusOffset;
      showSelectedTarget(target);
    });
  });

  if (selectedTarget) {
    const matching = [...documentRef.querySelectorAll("[data-anchor], [id]")].find((candidate) => candidate.getAttribute("data-anchor") === selectedTarget?.anchor || candidate.id === selectedTarget?.anchor);
    markTarget(matching ?? null);
  }
}

function scrollToAnchor(anchor: string): void {
  const documentRef = frame.contentDocument;
  if (!documentRef) return;
  const element = [...documentRef.querySelectorAll("[data-anchor], [id]")].find((candidate) => candidate.getAttribute("data-anchor") === anchor || candidate.id === anchor);
  if (element) {
    element.scrollIntoView({ behavior: "smooth", block: "start" });
    void targetFromElement(element).then(showSelectedTarget);
  } else {
    showToast(`Anchor #${anchor} is not present in this revision.`);
  }
}

function selectLocalQueueItem(index: number): void {
  const item = localQueue[index];
  if (!item) return;
  showSelectedTarget({ ...item.target, element: frame.contentDocument?.body ?? frame });
  feedbackBody.value = item.body;
  localQueue.splice(index, 1);
  saveDrafts();
  renderQueue();
  feedbackBody.focus();
}

async function queueComment(): Promise<void> {
  const body = feedbackBody.value.trim();
  if (!selectedTarget) return showToast("Select a block or text range first.");
  if (!body) return showToast("Add an instruction before queueing the comment.");
  localQueue.push({
    target: {
      anchor: selectedTarget.anchor,
      label: selectedTarget.label,
      quote: selectedTarget.quote,
      contextHash: selectedTarget.contextHash,
      startOffset: selectedTarget.startOffset,
      endOffset: selectedTarget.endOffset,
    },
    body,
    queueKey: `draft-${Date.now()}-${localQueue.length}`,
    tag: selectedTarget.quote ? "precise target" : "comment",
  });
  saveDrafts();
  feedbackBody.value = "";
  renderQueue();
  showToast("Comment queued locally. Send when the batch is ready.");
}

async function sendQueue(endSession = false): Promise<void> {
  if (localQueue.length === 0) return showToast("There are no local comments to send.");
  const response = await fetch(session.feedbackUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: localQueue }),
  });
  if (!response.ok) return showToast(`Could not send feedback (${response.status}).`);
  localQueue = [];
  saveDrafts();
  renderQueue();
  showToast("Feedback sent. The agent can receive the batch on its next poll.");
  if (endSession) {
    await fetch(session.statusUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "offline" }) });
  }
}

function moveLocalItem(index: number, direction: -1 | 1): void {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= localQueue.length) return;
  [localQueue[index], localQueue[targetIndex]] = [localQueue[targetIndex], localQueue[index]];
  saveDrafts();
  renderQueue();
}

function handleQueueAction(event: Event): void {
  const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
  if (!button) return;
  const index = Number(button.dataset.index);
  const action = button.dataset.action;
  if (!Number.isInteger(index)) return;
  if (action === "up") moveLocalItem(index, -1);
  if (action === "down") moveLocalItem(index, 1);
  if (action === "edit") selectLocalQueueItem(index);
  if (action === "remove") {
    localQueue.splice(index, 1);
    saveDrafts();
    renderQueue();
  }
}

function setView(view: "queue" | "history" | "review"): void {
  $("#queueView")!.toggleAttribute("hidden", view !== "queue");
  $("#historyView")!.toggleAttribute("hidden", view !== "history");
  $("#reviewView")!.toggleAttribute("hidden", view !== "review");
  $$<HTMLButtonElement>("[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
}

function updateFromEvent(event: { type: string; snapshot: SessionSnapshot }): void {
  session = { ...session, ...event.snapshot };
  render();
  if (event.type === "artifact") {
    artifactLoading.classList.remove("is-hidden");
    frame.src = `${session.artifactUrl}?revision=${session.artifactRevision}`;
  }
  if (event.type === "review") {
    renderCodeReview();
    setSurface("review");
    setView("review");
  }
}

async function loadArtifacts(): Promise<void> {
  const response = await fetch("/api/artifacts");
  if (!response.ok) return;
  const payload = await response.json() as { artifacts: ArtifactOption[] };
  const artifacts = payload.artifacts.length
    ? payload.artifacts
    : [{ id: session.id, name: session.filePath.split("/").pop() ?? session.filePath, filePath: session.filePath, url: location.origin, active: true, revision: session.artifactRevision, hasReview: Boolean(session.review) }];
  artifactSelect.innerHTML = artifacts.map((artifact) => `<option value="${escapeHtml(artifact.url)}" ${artifact.active ? "selected" : ""}>${escapeHtml(artifact.name)}${artifact.hasReview ? " · review" : ""}</option>`).join("");
  artifactSelect.title = session.filePath;
}

function queueFinding(index: number): void {
  const finding = session.review?.findings[index];
  if (!finding) return;
  localQueue.push({
    target: { anchor: findingAnchor(finding), label: `${finding.file}${finding.line ? `:${finding.line}` : ""}` },
    body: `Review finding: ${finding.title}\n\n${finding.body}`,
    queueKey: `review-${finding.id}`,
    tag: "code review",
  });
  saveDrafts();
  renderQueue();
  setView("queue");
  showToast("Finding added to the local discussion queue.");
}

function locateFinding(index: number): void {
  const finding = session.review?.findings[index];
  if (!finding) return;
  setSurface("review");
  const file = [...diffList.querySelectorAll<HTMLElement>(".diff-file")].find((element) => element.dataset.file === finding.file);
  file?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function boot(): Promise<void> {
  const response = await fetch("/api/session");
  if (!response.ok) throw new Error(`Session bootstrap failed: ${response.status}`);
  session = await response.json() as SessionSnapshot;
  loadDrafts();
  render();
  await loadArtifacts();

  frame.addEventListener("load", installArtifactHooks);
  frame.src = `${session.artifactUrl}?revision=${session.artifactRevision}`;

  const events = new EventSource(session.eventsUrl);
  events.onmessage = (message) => {
    try {
      updateFromEvent(JSON.parse(message.data) as { type: string; snapshot: SessionSnapshot });
    } catch {
      showToast("Received an invalid session event.");
    }
  };
  events.onerror = () => setStatusVisual(session.agentStatus);

  $("#queueComment")!.addEventListener("click", () => void queueComment());
  $("#sendQueue")!.addEventListener("click", () => void sendQueue());
  $("#sendEnd")!.addEventListener("click", () => void sendQueue(true));
  $("#clearTarget")!.addEventListener("click", () => showSelectedTarget(null));
  queueList.addEventListener("click", handleQueueAction);
  $("#openPanel")!.addEventListener("click", () => $("#rightRail")!.classList.toggle("is-open"));
  $("#reloadArtifact")!.addEventListener("click", () => {
    frame.src = `${session.artifactUrl}?revision=${session.artifactRevision}&reload=${Date.now()}`;
  });

  artifactSelect.addEventListener("change", () => {
    saveDrafts();
    if (artifactSelect.value && artifactSelect.value !== location.origin) location.href = artifactSelect.value;
  });

  $$<HTMLButtonElement>("[data-surface]").forEach((button) => button.addEventListener("click", () => setSurface(button.dataset.surface as "artifact" | "review")));

  $$<HTMLButtonElement>("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view as "queue" | "history" | "review")));
  reviewList.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-finding-action]");
    if (!button) return;
    const index = Number(button.dataset.index);
    if (button.dataset.findingAction === "queue") queueFinding(index);
    if (button.dataset.findingAction === "locate") locateFinding(index);
  });
  $("#copyReview")!.addEventListener("click", () => {
    void navigator.clipboard.writeText(reviewMarkdown()).then(() => showToast("GitHub-ready review copied. Nothing was posted."), () => showToast("Could not access the clipboard."));
  });
  $$<HTMLButtonElement>("[data-mode]").forEach((button) => button.addEventListener("click", () => {
    mode = button.dataset.mode as "annotate" | "explore";
    if (mode === "explore") markHoveredTarget(null);
    $$<HTMLButtonElement>("[data-mode]").forEach((candidate) => candidate.classList.toggle("is-active", candidate === button));
    showToast(mode === "annotate" ? "Annotate mode: select a block or text range." : "Explore mode: artifact controls stay live.");
  }));
  $$<HTMLButtonElement>("[data-nav]").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.nav === "queue") {
      $("#rightRail")!.classList.add("is-open");
      setView("queue");
    }
  }));
  sectionList.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-anchor]");
    if (button) scrollToAnchor(button.dataset.anchor ?? "");
  });
  feedbackBody.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void queueComment();
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void sendQueue();
    }
  });

  if (new URLSearchParams(location.search).get("view") === "review" && session.review) {
    setSurface("review");
    setView("review");
  }
}

boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Hone could not start.";
  artifactLoading.classList.remove("is-hidden");
  artifactLoading.textContent = message;
  showToast(message);
});
