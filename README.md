# FASK — Personal On-Screen Questions and Knowledge Space

**English** | [한국어](README.ko.md)

The desktop app is a personal, login-free edition. Questions are organized as Profile → Workspace → Project, and you ask them together with a screen region you have marked up with a pen on a transparent overlay. The legacy classroom server has been removed.

## Running the personal app

```powershell
cd desktop
npm ci
npm run dev
```

Use Node.js 22.13 or later. Data is stored with Electron's built-in `node:sqlite`, so no Python or separate database is required.

1. Connect the account you want to use in EasyCLIProxyAPI and start the local proxy.
2. In FASK, open **Settings · AI connection** and enter the OpenAI-compatible local API endpoint, e.g. `http://127.0.0.1:8317/v1`.
3. If the proxy requires one, enter the **local access key**. Keep it separate from provider API keys or management keys.
4. Click **Check connection · Load models** → choose default/fast/deep-reasoning models → **Save settings**.
5. In **Capture area**, pick a monitor and a rectangle. The inside stays sharp and the outside is dimmed; the box can be moved and resized from 8 directions.
6. In a project, click **Ask from screen**, mark the screen with the pen/eraser, and choose **Include screen capture** in the question panel. Pressing **Ask** captures the configured area at that moment and sends it with the question. Toggling the checkbox or refining the question does not take a capture.

Question refinement, model recommendation/auto-selection, and concept organization can each be turned on or off. Automatic concept organization makes an extra model request after the answer; new concepts are shown as suggestions. Questions marked important are used as context for later questions in the same project.

On the overlay, Esc exits pen mode. `Ctrl+Shift+Space` opens an on-screen question for the current project, or toggles the question panel when the overlay is already open. If another app holds that key, `Ctrl+Alt+Space` is registered as a fallback and the sidebar shows the key actually in use. The question button is always highlighted in a strong color. The question panel can be moved by its header and resized from the bottom-right handle; the size is remembered. Long answers scroll inside the panel.

Answers are rendered as Markdown (bold, italic, headings, lists, quotes, code blocks, tables, and LaTeX math) in the live panel, saved question details, and dashboard previews. The raw answer is kept as Markdown text.

Clicking another app closes the question panel while leaving that app focused. Merely moving the pointer outside an open panel does not close it. When the panel is closed and the pen is idle, leaving the toolbar relinquishes FASK's own keyboard focus without forcing another app to activate. Capture-area setup takes a fresh screen image with FASK windows excluded. Failed API requests preserve pen strokes and the question draft; strokes clear only after successful completion. The explicit capture-inclusion choice is remembered per profile.

Clicking **My space / Workspace / Project** in the breadcrumb returns to the parent list, and the left arrow goes back to the previous screen. Rename a workspace with **Rename** under the workspace selector, and a project with the **pencil button** next to its title.

New questions on the dashboard and overlay support the **Files·Images** button, drag and drop, and image paste. You can attach 1 image (PNG/JPEG/WebP/GIF) and up to 5 text/Markdown/code files (50,000 characters per file, 100,000 total). Binary documents such as PDF are not supported yet; unsupported files produce an error message.

The dashboard offers chronological/list/concept-graph views, text search, a complexity filter, notes, and concept linking. **Export memory** generates Markdown you can attach to another AI session. Backups in Settings are JSON including images; restoring creates a separate profile. Access keys are not backed up.

Personal data is stored in Electron `userData/personal/fask.sqlite`, images in `userData/personal/attachments/`. The default location on Windows is `%APPDATA%/fask/personal/`. Profiles are separated logically inside the database.

## File structure

```
desktop/                     Electron app (electron-vite, React, TypeScript, Tailwind)
  src/main/                  Main process
    index.ts                 App entry, main window
    profile.ts               --profile flag → separate userData directory
    personal.ts              IPC handlers (personal:*), wiring of store/API/capture
    personal-store.ts        node:sqlite store (records, preferences, runs, migrations)
    personal-capture.ts      Transparent overlay, capture-area editor, screen capture
    personal-shortcuts.ts    Global shortcut registration and fallback
    personal-backup.ts       JSON backup / restore
    local-api.ts             OpenAI-compatible local API client (streaming, models)
  src/preload/               window.fask bridge and its types (personal.d.ts)
  src/renderer/src/
    App.tsx                  Routes: dashboard, /personal-overlay, /capture-editor
    personal/                Dashboard, Overlay, Composer, Settings, CaptureEditor,
                             MarkdownAnswer, attachments, pen strokes
    components/MindMap/      Concept graph (React Flow + d3-hierarchy)
    lib/, api/types.ts       Tree building, question types, shared types
  tests/                     Unit tests (npm test) and Electron smoke tests
  build/, resources/         Icons, macOS entitlements, icon generator
docs/                        Personal app plan and current implementation contract
graphify-out/                Code graph analysis output
```

## Verification and packaging

```powershell
cd desktop
npm test
npm run typecheck
npm run build
npm run test:smoke
npm run build:unpack
```

`test:smoke` uses a real Electron window and a local test proxy. The capture source is replaced with the test app's own window, so no other app's screen or real subscription account is sent. Real Windows screen-capture permissions, multi-monitor setups, and per-account image support still need to be checked in your own environment.

See the [personal app plan](docs/PERSONAL_APP_PLAN.md) for the design and the [personal implementation doc](docs/PERSONAL_IMPLEMENTATION.md) for current scope and the IPC contract (both in Korean). MCP, embedding search, and JEV are future scope.

