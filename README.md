<div align="center">

# FASK

### Ask about your screen. Keep what you learn.

A personal desktop workspace for on-screen questions, AI answers, and connected knowledge.

[![Windows](https://img.shields.io/badge/Windows-Desktop-0078D4)](https://github.com/KyungMinseo1/FASK/releases)
[![Electron](https://img.shields.io/badge/Electron-React%20%2B%20TypeScript-47848F)](desktop/package.json)
[![Local storage](https://img.shields.io/badge/Storage-Local%20SQLite-6B8E23)](#data--privacy)

**[Download from Releases](https://github.com/KyungMinseo1/FASK/releases)** · [Getting started](#getting-started) · [Developer guide](#developer-guide)

**English** | [한국어](README.ko.md)

</div>

---

## Install & use

> **For everyday use, install the Windows app from [Releases](https://github.com/KyungMinseo1/FASK/releases).** Source setup is only needed for development.

1. Open **Releases** and choose a release with a Windows installer.
2. Under **Assets**, download the `setup.exe` installer. The configured filename is `fask-<version>-setup.exe`.
3. Run the installer and launch **FASK**.
4. Follow [Getting started](#getting-started) to connect your local AI proxy.

The Windows installer is the planned distribution format. If a release does not yet contain the installer, wait for it to be uploaded; GitHub's **Source code** ZIP/TAR files are not installers.

**No FASK login, Node.js, Python, or separate database installation is required for the installed app.** AI answers do require a running OpenAI-compatible local proxy and a connected provider account/model.

## What you can do

| Capture the question | Build your knowledge |
| --- | --- |
| Mark your screen with a transparent pen/eraser overlay | Organize records as **Profile → Workspace → Project** |
| Choose exactly which screen region to include | Read streamed answers with **Markdown and LaTeX** |
| Attach an image or text/code files | Search questions, add notes, and link concepts |
| Continue a conversation without leaving your screen; follow-ups stay in one question | Explore a concept graph and export memory as Markdown |

**Your workflow:** choose a project → mark the screen → ask → save the answer and its context.

## Getting started

### 1. Connect AI

1. Connect your provider account in **EasyCLIProxyAPI** and start its local proxy.
2. Open FASK **Settings · AI connection** and enter the OpenAI-compatible endpoint, for example `http://127.0.0.1:8317/v1`.
3. If required, enter the proxy's **local access key**—not a provider API key or management key.
4. Select **Check connection · Load models**, choose default/fast/deep-reasoning models, and save.

Provider sign-in and account routing are managed by the proxy, not FASK. Local browsing and manual organization work without an AI connection.

### 2. Set your capture area

Choose a monitor and rectangle in **Capture area**. Move the box or resize it from its eight handles; the selected area stays sharp and the outside is dimmed.

The editor and pen overlay use the same full-monitor coordinate space, including the taskbar area. The dotted pen-mode boundary represents the configured capture region.

### 3. Ask from your screen

Open a project, select **Ask from screen**, and mark anything relevant. Choose **Include screen capture**, then press **Ask**.

- The screen is captured **when you send**, not when you toggle capture or refine a question.
- Failed API requests keep your pen strokes and question draft. Strokes clear after successful completion.
- Answers support bold, italic, lists, code, tables, and LaTeX in the live panel, saved details, and dashboard previews.

### Android companion

In desktop **Settings → Mobile connection**, enable the hub and select a reachable LAN or Tailscale address. Scan its QR in the Android app. Keep the PC running; the phone uses its current profile and AI connection. Treat the QR as a password. Reset pairing to revoke existing phones.

The native app pins the PC certificate, stores pairing secrets in secure storage, and encrypts its offline snapshot. Offline records remain readable; AI requests require the PC. Camera/gallery attachments and Android text/image sharing open the shared question composer.

Build from `mobile/` with JDK 21 and Android SDK 36: `npm ci`, then `npm run apk`. The debug APK is `mobile/android/app/build/outputs/apk/debug/app-debug.apk`. Run `npm test` and `npm run test:android` for client/cache and native transport tests. `npm run apk:test` enables manual pairing-link entry for emulator checks; normal builds use QR scanning. Browser `npm run dev` is development-only and does not pin certificates.

Android launcher icons and splash screens reuse `desktop/build/icon.png`, including adaptive and round variants. After changing the Windows artwork, run `npx electron ../mobile/generate-icons.cjs` from `desktop/`, then rebuild the APK. Android launchers choose the outer mask.

### Shortcuts & overlay controls

| Control | Action |
| --- | --- |
| `Ctrl+Shift+Space` | Open the current project's overlay or toggle its question panel |
| `Ctrl+Alt+Space` | Fallback if the primary shortcut is occupied; the sidebar shows the registered key |
| `Esc` | Exit pen mode |
| Panel header / corner handle | Move / resize the question panel; geometry is remembered |
| Click another app | Focus that app and close the question panel, leaving the overlay available |

Moving the pointer outside an open panel does not close it. With the panel closed and pen idle, leaving the toolbar releases FASK's own keyboard focus without forcibly activating another app.

<details>
<summary><strong>Attachments, optional AI features, and navigation</strong></summary>

- **Attachments:** file picker, drag and drop, and image paste. One image (PNG/JPEG/WebP/GIF), plus up to five text/Markdown/code files: 50,000 characters per file, 100,000 total. PDF and other binary documents are not supported.
- **Optional AI:** independently enable question refinement, model recommendation/automatic selection, concept organization, and automatic titles. A new question gets an AI title generated in parallel with its answer from the question text, image, and attached files; renaming it yourself always wins. Automatic concept organization makes an additional model request and presents new concepts as suggestions. Important questions can provide context for later questions in the same project.
- **Conversations:** follow-up questions are stored as turns of the original question, so the dashboard, search, graph, and backups show one record per conversation. The question detail lists every turn with its own answer, attachments, and model.
- **Navigation:** use the **My space / Workspace / Project** breadcrumb and back arrow. Rename a workspace below its selector or a project with its pencil button.
- **Knowledge views:** chronological, list, and concept graph; text search, complexity filters, notes, and concept links.
- **Portability:** **Export memory** writes Markdown for another AI session. Settings provides JSON backup with images; restore creates a separate profile. Access keys are excluded. Backups from 1.0.x are imported with each conversation merged into one question.

</details>

## Data & privacy

| Item | Location / behavior |
| --- | --- |
| Questions, answers, settings | Electron `userData/personal/fask.sqlite` |
| Images | `userData/personal/attachments/` |
| Default Windows folder | `%APPDATA%/fask/personal/` |
| Profile separation | Logical scopes inside one local database, not OS-level isolation |
| 1.1.0 upgrade | Merges each 1.0.x conversation into one question on first launch; the untouched pre-upgrade database is kept as `fask-pre-1.1.0.sqlite` next to `fask.sqlite` |
| AI requests | Sent through your configured local proxy to its provider; local storage does **not** mean offline AI |

Raw answers are preserved as Markdown. No separate classroom backend is needed.

---

## Developer guide

> For modifying FASK or running from source. Ordinary users should use the **Releases installer** above.

### Run from source

Prerequisites: **Node.js 22.13+**, npm, and a running local AI proxy if you want model responses. SQLite is provided by Electron's built-in `node:sqlite`; no Python or database server is needed.

```powershell
git clone https://github.com/KyungMinseo1/FASK.git
cd FASK/desktop
npm ci
npm run dev
```

The development version runs the same personal app from source. This does not replace the proxy/account configuration in [Getting started](#getting-started).

### Checks & Windows packaging

Run from `desktop/`:

| Command | Purpose |
| --- | --- |
| `npm test` | Unit tests |
| `npm run typecheck` | Main/preload and renderer TypeScript checks |
| `npm run build` | Typecheck and production build |
| `npm run test:smoke` | Build, actual Electron UI smoke, and restart checks |
| `npm run build:unpack` | Build an unpacked application |
| `npm run build:win` | Build Windows distribution artifacts, including the NSIS installer |

Upload the generated `fask-<version>-setup.exe` to the GitHub release's **Assets**. Users should download that installer, not the source archive.

The integrated smoke uses a local test proxy and a deterministic capture fixture, not a real provider account or unrelated desktop content. Multi-monitor/DPI configurations and per-account image support still need environment-specific verification.

<details>
<summary><strong>Repository structure</strong></summary>

```text
desktop/                     Electron + React + TypeScript + Tailwind
  src/main/
    index.ts                 App entry and main window
    profile.ts               --profile → separate userData directory
    personal.ts              personal:* IPC handlers and service wiring
    personal-store.ts        Local SQLite records, settings, runs, migrations
    personal-capture.ts      Overlay, capture-area editor, screen capture
    personal-shortcuts.ts    Global shortcut registration and fallback
    personal-backup.ts       JSON backup / restore
    local-api.ts             OpenAI-compatible streaming and model client
  src/preload/               window.fask bridge and personal.d.ts contract
  src/shared/questions.ts    Question/turn helpers shared by main and renderer
  src/renderer/src/
    App.tsx                  Dashboard, /personal-overlay, /capture-editor
    personal/                Screens, composer, Markdown, attachments, pen strokes
    components/MindMap/      React Flow + d3-hierarchy concept graph
    lib/, api/types.ts       Tree helpers and shared types
  tests/                     Unit and Electron smoke tests
  build/, resources/         Icons, entitlements, icon generator
docs/                        Personal app design and implementation contract
graphify-out/                Code graph analysis output
```

</details>

### Design documents

- [Personal app plan](docs/PERSONAL_APP_PLAN.md) — design and planned scope (Korean)
- [Implementation contract](docs/PERSONAL_IMPLEMENTATION.md) — current behavior, storage, and IPC (Korean)

MCP, embedding search, and JEV are future scope, not current features.
