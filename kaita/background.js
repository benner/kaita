const api = globalThis.browser ?? globalThis.chrome;

const DATABASE_NAME = "domhistory";
const DATABASE_VERSION = 1;
const STORE_NAME = "snapshots";
const RECORDING_KEY = "recording";

const textEncoder = new TextEncoder();

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, {
        keyPath: "id",
        autoIncrement: true,
      });
      store.createIndex("tabId", "tabId");
      store.createIndex("ts", "ts");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function awaitRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function awaitTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function withStore(mode, callback) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const completed = awaitTransaction(transaction);
    const result = await callback(store);
    await completed;
    return result;
  } finally {
    database.close();
  }
}

function storeSnapshot(tabId, message) {
  return withStore("readwrite", (store) =>
    awaitRequest(
      store.add({
        tabId,
        url: message.url,
        ts: message.ts,
        html: message.html,
        size: textEncoder.encode(message.html).length,
      }),
    ),
  );
}

async function listSnapshots(tabId) {
  const records = await withStore("readonly", (store) =>
    awaitRequest(store.index("tabId").getAll(IDBKeyRange.only(tabId))),
  );
  return records
    .map(({ id, ts, url, size }) => ({ id, ts, url, size }))
    .sort((left, right) => left.ts - right.ts);
}

function getSnapshot(id) {
  return withStore("readonly", (store) => awaitRequest(store.get(id)));
}

function clearSnapshots(tabId) {
  return withStore("readwrite", async (store) => {
    const keys = await awaitRequest(
      store.index("tabId").getAllKeys(IDBKeyRange.only(tabId)),
    );
    for (const key of keys) {
      store.delete(key);
    }
  });
}

function openViewer(tabId) {
  return api.tabs.create({
    url: api.runtime.getURL(`viewer/viewer.html?tabId=${tabId}`),
  });
}

async function readRecordingState() {
  const stored = await api.storage.session.get(RECORDING_KEY);
  return stored[RECORDING_KEY] ?? {};
}

async function setRecording(tabId, recording) {
  const state = await readRecordingState();
  if (recording) {
    state[tabId] = true;
  } else {
    delete state[tabId];
  }
  await api.storage.session.set({ [RECORDING_KEY]: state });
}

async function recordingStatus(tabId) {
  const state = await readRecordingState();
  return { recording: state[tabId] === true };
}

function handleMessage(message, sender) {
  switch (message.type) {
    case "snapshot":
      return storeSnapshot(sender.tab.id, message);
    case "list":
      return listSnapshots(message.tabId);
    case "get":
      return getSnapshot(message.id);
    case "clear":
      return clearSnapshots(message.tabId);
    case "openViewer":
      return openViewer(message.tabId);
    case "recording":
      return setRecording(message.tabId ?? sender.tab.id, message.recording);
    case "status":
      return recordingStatus(message.tabId);
    default:
      return undefined;
  }
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const result = handleMessage(message, sender);
  if (result === undefined) {
    return false;
  }
  result.then(sendResponse, (error) => sendResponse({ error: String(error) }));
  return true;
});

api.tabs.onRemoved.addListener((tabId) => {
  setRecording(tabId, false);
});
