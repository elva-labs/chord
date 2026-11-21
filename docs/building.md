# Building

## Running it from source

```
npm install
npm run tauri dev
```

A development build wears an icon of its own, its tile in the accent rather than dark, so it is told from the installed app in the dock. The icons are drawn from SVG sources beside them, and `node src-tauri/icons/generate.mjs` draws every size and bundle format from those, over the files in the tree. It needs Playwright's Chromium (`npx playwright install chromium`), and macOS for the disk image's background.

Linux needs the WebKitGTK development packages Tauri asks for, plus `libxdo-dev`, `libayatana-appindicator3-dev` and `librsvg2-dev`.

## Verifying it

```
npm run verify        # types, unit, Rust, end-to-end
npm run test:driver   # the real binary, driven over WebDriver
```

[Testing](testing.md) says what each tier covers.
