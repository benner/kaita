import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const EXTENSION_SOURCE = new URL("../kaita/", import.meta.url).pathname;
const OUTPUT_DIR = new URL("./", import.meta.url).pathname;
const SCREENSHOTS_DIR = join(OUTPUT_DIR, "screenshots");
const FIREFOX_BINARY = resolveExecutable(process.env.FIREFOX_BINARY ?? "firefox");
const EXTENSION_UUID = "5d6d9f0d-d30c-41e3-bf87-21ea95d0a948";
const DEMO_URL = "https://todomvc.com/examples/javascript-es6/dist/";
const WIDTH = 1280;
const HEIGHT = 800;
const POPUP_WIDTH = 304;
const POPUP_HEIGHT = 200;
const TYPING_SECONDS = 0.06;
const TODOS = ["Publish Kaita on AMO", "Record a demo", "Write release notes"];

function resolveExecutable(name) {
  if (name.includes("/")) {
    return name;
  }
  for (const directory of process.env.PATH.split(":")) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`${name} not found on PATH`);
}

const framesDir = mkdtempSync(join(tmpdir(), "kaita-demo-frames-"));
mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// activeTab cannot be granted without a real toolbar click, so the demo
// runs a copy of the extension that holds the equivalent host permission.
const extensionDir = mkdtempSync(join(tmpdir(), "kaita-demo-extension-"));
cpSync(EXTENSION_SOURCE, extensionDir, { recursive: true });
const manifestPath = join(extensionDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions = ["<all_urls>"];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const timeline = [];
let frameIndex = 0;

function nextFramePath() {
  frameIndex += 1;
  return join(framesDir, `frame-${String(frameIndex).padStart(4, "0")}.png`);
}

function composePopup(basePath, popupPath, outputPath) {
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    basePath,
    "-i",
    popupPath,
    "-filter_complex",
    "[1]pad=iw+2:ih+2:1:1:color=#9a9aa5[popup];" +
      "[0][popup]overlay=W-w-24:12",
    outputPath,
  ]);
}

async function capture(page, holdSeconds, { popup, screenshotName } = {}) {
  const framePath = nextFramePath();
  if (popup) {
    const basePath = framePath.replace(".png", "-base.png");
    const popupPath = framePath.replace(".png", "-popup.png");
    await page.screenshot({ path: basePath });
    const height = await popup.evaluate(
      () => document.documentElement.scrollHeight,
    );
    await popup.screenshot({
      path: popupPath,
      clip: { x: 0, y: 0, width: POPUP_WIDTH, height },
    });
    composePopup(basePath, popupPath, framePath);
  } else {
    await page.screenshot({ path: framePath });
  }
  timeline.push({ path: framePath, seconds: holdSeconds });
  if (screenshotName) {
    copyFileSync(framePath, join(SCREENSHOTS_DIR, `${screenshotName}.png`));
  }
}

// The viewer re-renders its rows and diff every two seconds while the tab
// records, so a click must resolve and dispatch in one step.
function clickInPage(page, selector) {
  return page.evaluate((query) => {
    const element = document.querySelector(query);
    if (!element) {
      throw new Error(`no element for ${query}`);
    }
    element.click();
  }, selector);
}

async function typeText(page, text) {
  for (const character of text) {
    await page.keyboard.type(character);
    await capture(page, TYPING_SECONDS);
  }
}

// WebDriver BiDi never reports load for moz-extension:// navigations,
// so wait for the extension API to appear instead.
async function openExtensionPage(page, path) {
  try {
    await page.goto(`moz-extension://${EXTENSION_UUID}/${path}`, {
      timeout: 5000,
    });
  } catch {
    /* expected, see above */
  }
  await page.waitForFunction(() => typeof browser !== "undefined");
}

function encodeVideo() {
  const listPath = join(framesDir, "frames.txt");
  const entries = timeline.map(
    (frame) => `file '${frame.path}'\nduration ${frame.seconds}`,
  );
  entries.push(`file '${timeline.at(-1).path}'`);
  writeFileSync(listPath, `${entries.join("\n")}\n`);
  const videoPath = join(OUTPUT_DIR, "demo.mp4");
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-vf",
    "fps=15,format=yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "22",
    "-movflags",
    "+faststart",
    videoPath,
  ]);
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    videoPath,
    "-vf",
    "fps=10,scale=960:-1:flags=lanczos,split[a][b];" +
      "[a]palettegen=max_colors=128[palette];" +
      "[b][palette]paletteuse=dither=bayer:bayer_scale=5",
    join(OUTPUT_DIR, "demo.gif"),
  ]);
}

const profileDir = mkdtempSync(join(tmpdir(), "kaita-demo-profile-"));
const browser = await puppeteer.launch({
  browser: "firefox",
  executablePath: FIREFOX_BINARY,
  headless: true,
  userDataDir: profileDir,
  defaultViewport: { width: WIDTH, height: HEIGHT },
  args: ["--remote-allow-system-access"],
  extraPrefsFirefox: {
    "extensions.webextensions.uuids": JSON.stringify({
      [manifest.browser_specific_settings.gecko.id]: EXTENSION_UUID,
    }),
  },
});

try {
  await browser.installExtension(extensionDir);

  const site = await browser.newPage();
  await site.goto(DEMO_URL, { waitUntil: "networkidle0" });
  await site.waitForSelector(".new-todo");
  await capture(site, 1.5);

  // The popup binds to the active tab when it loads, so the site tab must be
  // in front while popup.html is navigated in a second tab.
  const popup = await browser.newPage();
  await popup.setViewport({ width: POPUP_WIDTH, height: POPUP_HEIGHT });
  await site.bringToFront();
  await openExtensionPage(popup, "popup/popup.html");
  await popup.waitForFunction(
    () => document.getElementById("count").textContent !== "",
  );
  await capture(site, 1.5, { popup });

  await popup.click("#record");
  await popup.waitForFunction(
    () => document.getElementById("record").textContent === "Stop recording",
  );
  await sleep(300);
  await capture(site, 2, { popup, screenshotName: "1-popup-recording" });

  await site.click(".new-todo");
  for (const todo of TODOS) {
    await typeText(site, todo);
    await site.keyboard.press("Enter");
    await sleep(400);
    await capture(site, 0.8);
  }
  await site.click(".todo-list li:nth-child(2) .toggle");
  await sleep(400);
  await capture(site, 1.5);

  await site.bringToFront();
  await openExtensionPage(popup, "popup/popup.html?reopened");
  await popup.waitForFunction(
    () => document.getElementById("count").textContent !== "",
  );
  await capture(site, 2, { popup });

  // The tab the popup opens is not exposed to puppeteer, so open the viewer
  // for the same tab id in a page puppeteer controls.
  await popup.click("#view");
  const siteTabId = await popup.evaluate(async (url) => {
    const tabs = await browser.tabs.query({});
    return tabs.find((tab) => tab.url === url).id;
  }, DEMO_URL);
  const viewer = await browser.newPage();
  await openExtensionPage(viewer, `viewer/viewer.html?tabId=${siteTabId}`);
  await viewer.bringToFront();
  await viewer.waitForFunction(
    () => document.querySelectorAll("#rows tr").length >= 5,
  );
  await viewer.waitForSelector("#diff .line");
  await capture(viewer, 2.5, { screenshotName: "2-viewer-diff" });

  await clickInPage(viewer, "#diff .expander:nth-of-type(2)");
  await sleep(200);
  await capture(viewer, 2);

  const firstId = await viewer.evaluate(
    () => document.querySelector('#rows input[name="old"]').value,
  );
  await clickInPage(viewer, `#rows input[name="old"][value="${firstId}"]`);
  await viewer.waitForSelector("#diff .line.added");
  await viewer.evaluate(() =>
    document
      .querySelector("#diff .line.added")
      .scrollIntoView({ block: "center" }),
  );
  await sleep(200);
  await capture(viewer, 2.5);

  await clickInPage(viewer, '.tab[data-pane="source"]');
  await sleep(200);
  await capture(viewer, 1.5);

  await clickInPage(viewer, "#rows tr:nth-child(2) td.time");
  await viewer.waitForFunction(
    () => document.getElementById("page-revision").textContent === "#2",
  );
  await sleep(1500);
  await capture(viewer, 2.5, { screenshotName: "3-viewer-page-pinned" });

  await clickInPage(viewer, 'input[name="render"][value="new"]');
  await sleep(1500);
  await capture(viewer, 3);

  encodeVideo();
  console.log(`${timeline.length} frames -> ${OUTPUT_DIR}`);
} finally {
  await browser.close();
  for (const directory of [framesDir, extensionDir, profileDir]) {
    rmSync(directory, { recursive: true, force: true });
  }
}
