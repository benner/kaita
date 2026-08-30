if (!globalThis.domHistoryRecorder) {
  const api = globalThis.browser ?? globalThis.chrome;
  const DEBOUNCE_MILLISECONDS = 100;

  const FORM_CONTROLS = "input, textarea, option";

  function serializeDocument() {
    const root = document.documentElement;
    const clone = root.cloneNode(true);
    const liveControls = root.querySelectorAll(FORM_CONTROLS);
    const clonedControls = clone.querySelectorAll(FORM_CONTROLS);
    liveControls.forEach((live, index) => {
      const copy = clonedControls[index];
      if (live.localName === "option") {
        copy.toggleAttribute("selected", live.selected);
      } else if (live.localName === "textarea") {
        copy.textContent = live.value;
      } else if (live.type === "checkbox" || live.type === "radio") {
        copy.toggleAttribute("checked", live.checked);
      } else if (live.type !== "password" && live.type !== "file") {
        copy.setAttribute("value", live.value);
      }
    });
    return clone.outerHTML;
  }

  const recorder = {
    observer: null,
    timer: null,
    lastHtml: null,

    snapshot() {
      clearTimeout(this.timer);
      this.timer = null;
      const html = serializeDocument();
      if (html === this.lastHtml) {
        return;
      }
      this.lastHtml = html;
      api.runtime.sendMessage({
        type: "snapshot",
        url: location.href,
        ts: Date.now(),
        html,
      });
    },

    schedule() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.snapshot(), DEBOUNCE_MILLISECONDS);
    },

    start() {
      if (this.observer) {
        return;
      }
      this.lastHtml = null;
      this.snapshot();
      this.observer = new MutationObserver(() => this.schedule());
      this.observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    },

    stop() {
      if (!this.observer) {
        return;
      }
      this.observer.disconnect();
      this.observer = null;
      if (this.timer !== null) {
        this.snapshot();
      }
    },

    isRecording() {
      return this.observer !== null;
    },
  };

  globalThis.domHistoryRecorder = recorder;

  window.addEventListener("pagehide", () => {
    if (recorder.isRecording()) {
      recorder.stop();
      api.runtime.sendMessage({ type: "recording", recording: false });
    }
  });

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "start") {
      recorder.start();
    } else if (message.type === "stop") {
      recorder.stop();
    }
    sendResponse({ recording: recorder.isRecording() });
  });
}
