import { diffLines } from "../vendor/diff.js";

const api = globalThis.browser ?? globalThis.chrome;

const CONTEXT_LINES = 3;
const REFRESH_MILLISECONDS = 2000;
const REVOKE_DELAY_MILLISECONDS = 1000;

const tabId = Number(new URLSearchParams(location.search).get("tabId"));

const rowsElement = document.getElementById("rows");
const emptyElement = document.getElementById("empty");
const recordingElement = document.getElementById("recording");
const exportButton = document.getElementById("export");
const summaryElement = document.getElementById("summary");
const panes = {
  diff: document.getElementById("diff"),
  source: document.getElementById("source"),
  page: document.getElementById("page"),
};
const frameElement = document.getElementById("frame");
const pageUrlElement = document.getElementById("page-url");
const pageRevisionElement = document.getElementById("page-revision");
const tabButtons = [...document.querySelectorAll(".tab")];
const renderRadios = [...document.querySelectorAll('input[name="render"]')];

let revisions = [];
let oldId = null;
let newId = null;
let followLatest = true;
let activePane = "diff";
let renderRole = "new";
let pinnedId = null;
let pageStale = true;
let renderedPageId = null;
let renderToken = 0;
const snapshotCache = new Map();

function pad(value, width) {
  return String(value).padStart(width, "0");
}

function formatTime(ts) {
  const date = new Date(ts);
  return (
    `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:` +
    `${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}`
  );
}

function formatDelta(revision, previous) {
  return previous ? `+${revision.ts - previous.ts} ms` : "";
}

function prettyPrint(html) {
  return html.replace(/</g, "\n<").replace(/^\n/, "");
}

function splitLines(value) {
  const lines = value.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function withBase(html, url) {
  const base = `<base href="${escapeAttribute(url)}">`;
  const headPattern = /<head[^>]*>/i;
  return headPattern.test(html)
    ? html.replace(headPattern, (match) => match + base)
    : base + html;
}

async function getSnapshot(id) {
  if (!snapshotCache.has(id)) {
    const record = await api.runtime.sendMessage({ type: "get", id });
    snapshotCache.set(id, {
      raw: record.html,
      url: record.url,
      pretty: prettyPrint(record.html),
    });
  }
  return snapshotCache.get(id);
}

async function fetchRevisions() {
  revisions = await api.runtime.sendMessage({ type: "list", tabId });
}

function applyDefaultSelection() {
  const ids = revisions.map((revision) => revision.id);
  if (followLatest || !ids.includes(newId) || !ids.includes(oldId)) {
    newId = ids.at(-1) ?? null;
    oldId = ids.at(-2) ?? newId;
  }
  if (pinnedId !== null && !ids.includes(pinnedId)) {
    renderRole = "new";
    pinnedId = null;
    syncRenderRadios();
  }
}

function displayedId() {
  if (renderRole === "old") {
    return oldId;
  }
  if (renderRole === "new") {
    return newId;
  }
  return pinnedId;
}

function syncRenderRadios() {
  for (const radio of renderRadios) {
    radio.checked = radio.value === renderRole;
  }
}

function setRenderRole(role, id) {
  renderRole = role;
  pinnedId = id;
  syncRenderRadios();
  renderTable();
  pageStale = true;
  if (activePane === "page") {
    renderPage();
  }
}

function viewRevision(id) {
  setRenderRole("pinned", id);
  showPane("page");
}

function select(role, id) {
  if (role === "old") {
    oldId = id;
  } else {
    newId = id;
  }
  followLatest = false;
  render();
}

function radioCell(role, id) {
  const cell = document.createElement("td");
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = role;
  radio.value = String(id);
  radio.checked = (role === "old" ? oldId : newId) === id;
  radio.addEventListener("change", () => select(role, id));
  cell.append(radio);
  return cell;
}

function textCell(text, className) {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) {
    cell.className = className;
  }
  return cell;
}

function renderTable() {
  const rows = revisions.map((revision, index) => {
    const row = document.createElement("tr");
    row.classList.toggle("old", revision.id === oldId);
    row.classList.toggle("new", revision.id === newId);
    row.classList.toggle("viewed", revision.id === displayedId());
    row.addEventListener("click", (event) => {
      if (!event.target.closest("input")) {
        viewRevision(revision.id);
      }
    });
    row.append(
      textCell(String(index + 1)),
      textCell(formatTime(revision.ts), "time"),
      textCell(formatDelta(revision, revisions[index - 1])),
      textCell(String(revision.size)),
      radioCell("old", revision.id),
      radioCell("new", revision.id),
    );
    return row;
  });
  rowsElement.replaceChildren(...rows);
  emptyElement.hidden = revisions.length > 0;
  exportButton.disabled = newId === null;
}

function lineElement(text, kind) {
  const element = document.createElement("div");
  element.className = `line ${kind}`;
  const prefix = { added: "+ ", removed: "- ", context: "  " }[kind];
  element.textContent = prefix + text;
  return element;
}

function expanderElement(hiddenLines) {
  const button = document.createElement("button");
  button.className = "expander";
  button.textContent = `… ${hiddenLines.length} unchanged lines`;
  button.addEventListener("click", () => {
    button.replaceWith(...hiddenLines.map((line) => lineElement(line, "context")));
  });
  return button;
}

function contextElements(lines, isFirst, isLast) {
  const leading = isFirst ? 0 : CONTEXT_LINES;
  const trailing = isLast ? 0 : CONTEXT_LINES;
  if (lines.length <= leading + trailing) {
    return lines.map((line) => lineElement(line, "context"));
  }
  const hidden = lines.slice(leading, lines.length - trailing);
  return [
    ...lines.slice(0, leading).map((line) => lineElement(line, "context")),
    expanderElement(hidden),
    ...lines.slice(lines.length - trailing).map((line) => lineElement(line, "context")),
  ];
}

function renderDiff(oldHtml, newHtml) {
  const parts = diffLines(oldHtml, newHtml);
  const elements = [];
  let added = 0;
  let removed = 0;
  parts.forEach((part, index) => {
    const lines = splitLines(part.value);
    if (part.added) {
      added += lines.length;
      elements.push(...lines.map((line) => lineElement(line, "added")));
    } else if (part.removed) {
      removed += lines.length;
      elements.push(...lines.map((line) => lineElement(line, "removed")));
    } else {
      elements.push(
        ...contextElements(lines, index === 0, index === parts.length - 1),
      );
    }
  });
  panes.diff.replaceChildren(...elements);
  summaryElement.textContent = `+${added} −${removed}`;
}

async function renderPage() {
  const id = displayedId();
  if (id === null) {
    return;
  }
  pageStale = false;
  if (id === renderedPageId) {
    return;
  }
  const snapshot = await getSnapshot(id);
  const index = revisions.findIndex((revision) => revision.id === id);
  frameElement.srcdoc = withBase(snapshot.raw, snapshot.url);
  pageRevisionElement.textContent = `#${index + 1}`;
  pageUrlElement.textContent = snapshot.url;
  renderedPageId = id;
}

async function renderPanes() {
  const token = ++renderToken;
  if (newId === null) {
    panes.diff.replaceChildren();
    panes.source.textContent = "";
    summaryElement.textContent = "";
    frameElement.removeAttribute("srcdoc");
    pageRevisionElement.textContent = "";
    pageUrlElement.textContent = "";
    renderedPageId = null;
    return;
  }
  const [oldSnapshot, newSnapshot] = await Promise.all([
    getSnapshot(oldId),
    getSnapshot(newId),
  ]);
  if (token !== renderToken) {
    return;
  }
  renderDiff(oldSnapshot.pretty, newSnapshot.pretty);
  panes.source.textContent = newSnapshot.pretty;
  pageStale = true;
  if (activePane === "page") {
    renderPage();
  }
}

function render() {
  renderTable();
  renderPanes();
}

async function refresh() {
  await fetchRevisions();
  applyDefaultSelection();
  render();
}

function showPane(name) {
  activePane = name;
  for (const [paneName, pane] of Object.entries(panes)) {
    pane.hidden = paneName !== activePane;
  }
  for (const button of tabButtons) {
    button.classList.toggle("active", button.dataset.pane === activePane);
  }
  if (activePane === "page" && pageStale) {
    renderPage();
  }
}

function moveSelection(role, step) {
  const ids = revisions.map((revision) => revision.id);
  const current = role === "old" ? oldId : newId;
  const index = ids.indexOf(current);
  const next = Math.min(Math.max(index + step, 0), ids.length - 1);
  if (ids.length > 0 && next !== index) {
    select(role, ids[next]);
  }
}

function handleKey(event) {
  if (event.target.matches("input, textarea, button")) {
    return;
  }
  const key = event.key.toLowerCase();
  if (key !== "j" && key !== "k") {
    return;
  }
  event.preventDefault();
  const role = event.shiftKey || event.key !== key ? "old" : "new";
  moveSelection(role, key === "j" ? 1 : -1);
}

async function exportSnapshot() {
  const revision = revisions.find((candidate) => candidate.id === newId);
  const snapshot = await getSnapshot(newId);
  const blob = new Blob([snapshot.raw], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${revision.ts}.html`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MILLISECONDS);
}

async function pollRecording() {
  const status = await api.runtime.sendMessage({ type: "status", tabId });
  recordingElement.hidden = !status.recording;
  if (status.recording) {
    await refresh();
  }
}

for (const button of tabButtons) {
  button.addEventListener("click", () => showPane(button.dataset.pane));
}
for (const radio of renderRadios) {
  radio.addEventListener("change", () => setRenderRole(radio.value, null));
}
exportButton.addEventListener("click", exportSnapshot);
document.addEventListener("keydown", handleKey);

showPane(activePane);
await refresh();
await pollRecording();
setInterval(pollRecording, REFRESH_MILLISECONDS);
