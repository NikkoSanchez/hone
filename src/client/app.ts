type AgentStatus = "listening" | "working" | "offline";

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

let session: SessionSnapshot;
let localQueue: FeedbackItem[] = [];
let selectedTarget: SelectedTarget | null = null;
let mode: "annotate" | "explore" = "annotate";
let toastTimer: number | undefined;
let ignoreNextArtifactClick = false;
let hoveredArtifactElement: Element | null = null;

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
    ? messages.map((message) => `<article class="history-card ${escapeHtml(message.role)}"><div class="message-meta"><strong>${escapeHtml(message.role === "agent" ? "Agent" : message.role === "user" ? "You" : "Pair Plan")}</strong><span>${escapeHtml(formatTime(message.createdAt))}</span></div><p class="message-body">${escapeHtml(message.body)}</p></article>`).join("")
    : `<div class="empty-state">No delivered messages yet.</div>`;
}

function render(): void {
  $("#sessionId")!.textContent = session.id;
  $("#revisionLabel")!.textContent = `rev ${session.artifactRevision}`;
  $("#artifactFile")!.textContent = session.filePath;
  setStatusVisual(session.agentStatus);
  renderQueue();
  renderHistory();
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
  for (const marked of [...documentRef.querySelectorAll("[data-pair-plan-target]")]) marked.removeAttribute("data-pair-plan-target");
  element?.setAttribute("data-pair-plan-target", "true");
}

function markHoveredTarget(element: Element | null): void {
  if (hoveredArtifactElement && hoveredArtifactElement !== element) {
    hoveredArtifactElement.removeAttribute("data-pair-plan-hover");
  }
  hoveredArtifactElement = element;
  if (element && element !== selectedTarget?.element) {
    element.setAttribute("data-pair-plan-hover", "true");
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
  style.textContent = `[data-pair-plan-hover]{outline:2px solid #f4c95d !important;outline-offset:3px !important;}[data-pair-plan-target]{outline:2px solid #1eb9b0 !important;outline-offset:3px !important;}`;
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
    renderQueue();
  }
}

function setView(view: "queue" | "history"): void {
  $("#queueView")!.toggleAttribute("hidden", view !== "queue");
  $("#historyView")!.toggleAttribute("hidden", view !== "history");
  $$<HTMLButtonElement>("[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
}

function updateFromEvent(event: { type: string; snapshot: SessionSnapshot }): void {
  session = { ...session, ...event.snapshot };
  render();
  if (event.type === "artifact") {
    artifactLoading.classList.remove("is-hidden");
    frame.src = `${session.artifactUrl}?revision=${session.artifactRevision}`;
  }
}

async function boot(): Promise<void> {
  const response = await fetch("/api/session");
  if (!response.ok) throw new Error(`Session bootstrap failed: ${response.status}`);
  session = await response.json() as SessionSnapshot;
  render();

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

  $$<HTMLButtonElement>("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view as "queue" | "history")));
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
}

boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Pair Plan could not start.";
  artifactLoading.classList.remove("is-hidden");
  artifactLoading.textContent = message;
  showToast(message);
});
