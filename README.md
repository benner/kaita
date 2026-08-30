# Kaita — DOM History

Browser extension for Firefox and Chromium browsers (Chrome, Brave, Edge)
that records DOM snapshots of a page on demand and lets you browse and diff
them like a wiki page history. Kaita is Lithuanian for *change*.

Nothing runs on any page until you click **Record changes** on it, so
recording is opt-in per site. Snapshots are stored locally in IndexedDB and
never leave the browser.

## Usage

1. Open the page you want to watch and click the toolbar button.
2. **Record changes** takes a snapshot immediately and then one after every
   burst of DOM mutations. The same button becomes **Stop recording**.
   A snapshot is the page's live DOM as HTML, including form state the
   markup alone does not carry (ticked boxes, typed values, chosen
   options); password fields are never captured.
3. **View changes** opens the history viewer for this tab.
4. **Clear collected history** deletes this tab's snapshots.

### Viewer

The left pane lists revisions with time, delta to the previous revision and
size; the `old` / `new` radio columns pick the pair to compare, defaulting to
the last two. `j` / `k` move the `new` selection, `Shift` + `j` / `k` move
`old`. **Diff** shows a unified line diff of the pretty-printed HTML with
unchanged regions collapsed to three lines of context; **Source** shows the
`new` snapshot. **Export** downloads the `new` snapshot as `<timestamp>.html`.
The list refreshes every two seconds while the tab is still recording.

## Development

One Manifest V3 codebase serves both browser families. Firefox uses
`background.scripts`, Chromium uses `background.service_worker`; each ignores
the other's key. All extension code goes through
`globalThis.browser ?? globalThis.chrome`, so no polyfill is needed.

Firefox: load the `kaita/` directory via `about:debugging` → *This Firefox*
→ *Load Temporary Add-on* and pick `kaita/manifest.json`.

Chrome / Brave / Edge: open `chrome://extensions`, enable *Developer mode*,
click *Load unpacked* and pick the `kaita/` directory.

```sh
npm install
npm run lint
```

`npm run lint` runs `eslint .` and `web-ext lint`; both must report zero
errors.

### Vendored dependencies

`kaita/vendor/diff.js` is `lib/index.mjs` from the
[`diff`](https://www.npmjs.com/package/diff) package, version 7.0.0, copied
byte-for-byte with `npm run vendor:diff`. Never edit it by hand; bump the
pinned version in `package.json` and re-run the script instead.
