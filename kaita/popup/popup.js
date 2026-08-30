const api = globalThis.browser ?? globalThis.chrome;

const urlElement = document.getElementById("url");
const stateElement = document.getElementById("state");
const countElement = document.getElementById("count");
const errorElement = document.getElementById("error");
const recordButton = document.getElementById("record");
const viewButton = document.getElementById("view");
const clearButton = document.getElementById("clear");

const [tab] = await api.tabs.query({ active: true, currentWindow: true });

function showError(error) {
  errorElement.textContent = error.message;
  errorElement.hidden = false;
}

function clearError() {
  errorElement.hidden = true;
}

async function contentRecording() {
  try {
    const reply = await api.tabs.sendMessage(tab.id, { type: "status" });
    return reply.recording;
  } catch {
    return false;
  }
}

async function refresh() {
  urlElement.textContent = tab.url;
  urlElement.title = tab.url;
  const recording = await contentRecording();
  await api.runtime.sendMessage({
    type: "recording",
    tabId: tab.id,
    recording,
  });
  stateElement.dataset.recording = String(recording);
  stateElement.textContent = recording ? "Recording" : "Not recording";
  recordButton.textContent = recording ? "Stop recording" : "Record changes";
  const snapshots = await api.runtime.sendMessage({
    type: "list",
    tabId: tab.id,
  });
  countElement.textContent = `${snapshots.length} snapshot${
    snapshots.length === 1 ? "" : "s"
  }`;
}

async function injectRecorder() {
  const [injection] = await api.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["/content.js"],
  });
  if (injection?.error) {
    throw new Error(injection.error.message ?? String(injection.error));
  }
}

async function toggleRecording() {
  clearError();
  try {
    if (await contentRecording()) {
      await api.tabs.sendMessage(tab.id, { type: "stop" });
    } else {
      await injectRecorder();
      await api.tabs.sendMessage(tab.id, { type: "start" });
    }
  } catch (error) {
    showError(error);
  }
  await refresh();
}

async function openViewer() {
  await api.runtime.sendMessage({ type: "openViewer", tabId: tab.id });
  window.close();
}

async function clearHistory() {
  clearError();
  try {
    await api.runtime.sendMessage({ type: "clear", tabId: tab.id });
  } catch (error) {
    showError(error);
  }
  await refresh();
}

recordButton.addEventListener("click", toggleRecording);
viewButton.addEventListener("click", openViewer);
clearButton.addEventListener("click", clearHistory);

await refresh();
