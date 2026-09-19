# Flyout Agenda

A browser extension that adds one or more editable, resizable flyout panels to the left edge of any page — handy for keeping an agenda, notes, or quick links visible while you browse.

## Features

- **Multiple flyouts** — create, rename, enable/disable, and delete as many flyouts as you want from the toolbar popup. Only one is shown on the page at a time.
- **Editable content** — click into an open flyout and type directly; edits are saved automatically.
- **Formatting toolbar** — a ribbon above each flyout's content offers paragraph/heading styles, bold, italic, underline, strikethrough, bullet/numbered/checklist lists, links, and clear formatting. Checklist items have real, clickable checkboxes. The ribbon can be minimized via the panel header, and that preference is remembered across pages and tabs.
- **Resizable** — drag the panel's right edge to resize it. Each flyout remembers its own width.
- **Persistent state** — which flyout was open (or that the panel was closed) and each flyout's width are restored on page reload.
- **Links open in the current tab** — regardless of how a link is authored in the flyout's content.
- **Global on/off switch** — hide flyouts on all pages from the toolbar popup without losing any content.
- **SPA-aware** — the panel survives client-side route changes on single-page apps.

## Installation

1. Open `chrome://extensions` (or the equivalent in your Chromium-based browser).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this project's folder.

## Usage

- Click the extension icon in the toolbar to open the popup, where you can toggle flyouts on/off globally and manage individual flyouts (add, rename, enable/disable, delete).
- On any page, click a tab on the left edge to open its flyout.
- Click inside an open flyout and start typing to edit its content, using the formatting toolbar for headings, bold/italic/underline/strikethrough, lists, and links.
- Drag the flyout's right edge to resize it.
- Use **Reset** in the panel header to restore a flyout's default content, or **Close** to collapse it.

## Project structure

| File | Purpose |
| --- | --- |
| [manifest.json](manifest.json) | Extension manifest (Manifest V3). |
| [content-script.js](content-script.js) | Injected into every page; builds and manages the flyout panel(s). |
| [popup.html](popup.html) / [popup.js](popup.js) | Toolbar popup UI for managing flyouts and the global enable switch. |
| [panel-content.html](panel-content.html) | Default content used to seed the first flyout. |
| [icons/](icons/) | Extension icons. |

## Storage

All state is kept in `chrome.storage.local`:

- `flyouts` — array of `{ id, name, enabled, html, width }` objects, one per flyout.
- `globalEnabled` — boolean, whether flyouts are shown on pages at all.
- `openFlyoutId` — id of the flyout that was last open (or `null` if closed), restored on page load.
- `toolbarCollapsed` — boolean, whether the formatting ribbon is minimized. Shared across all flyouts and tabs.

## Permissions

- `storage` — to persist flyout content, settings, and layout state.
