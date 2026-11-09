<div align="center">

<img src="desktop/build/icon.png" alt="FASK logo" width="112" height="112" />

<h1>FASK</h1>

<p><strong>Ask about your screen. Keep what you learn.</strong></p>

<p>A personal desktop workspace for on-screen questions, AI answers, and connected knowledge.</p>

<p>
  <a href="https://github.com/KyungMinseo1/FASK/releases"><img alt="Windows" src="https://img.shields.io/badge/Windows-desktop-7769F0?style=flat-square&logo=windows&logoColor=white" /></a>
  <a href="mobile/"><img alt="Android" src="https://img.shields.io/badge/Android-companion-7769F0?style=flat-square&logo=android&logoColor=white" /></a>
  <a href="desktop/package.json"><img alt="Electron" src="https://img.shields.io/badge/Electron-React%20·%20TypeScript-2B2D42?style=flat-square&logo=electron&logoColor=white" /></a>
  <a href="#data--privacy"><img alt="Local SQLite" src="https://img.shields.io/badge/Storage-local%20SQLite-2B2D42?style=flat-square&logo=sqlite&logoColor=white" /></a>
</p>

<p>
  <a href="https://github.com/KyungMinseo1/FASK/releases"><strong>Download</strong></a>
  &nbsp;·&nbsp;
  <a href="#getting-started">Getting started</a>
  &nbsp;·&nbsp;
  <a href="#developer-guide">Developer guide</a>
</p>

<sub><strong>English</strong> &nbsp;|&nbsp; <a href="README.ko.md">한국어</a></sub>

</div>

<br />

> **Mark** the screen &nbsp;→&nbsp; **Ask** in place &nbsp;→&nbsp; **Keep** the answer with its context.

<p align="center">
  <img src="https://github.com/user-attachments/assets/fc62547f-817f-455e-a003-981e6e6a0046" alt="FASK demo" width="800" />
</p>

---

## Install & use

> **For everyday use, install the Windows app from [Releases](https://github.com/KyungMinseo1/FASK/releases).** Source setup is only needed for development.

1. Open **Releases** and choose a release with a Windows installer.
2. Under **Assets**, download the `setup.exe` installer. The configured filename is `fask-<version>-setup.exe`.
3. Run the installer and launch **FASK**.
4. Follow [Getting started](#getting-started) to connect an OpenAI-compatible API.

The Windows installer is the planned distribution format. If a release does not yet contain the installer, wait for it to be uploaded; GitHub's **Source code** ZIP/TAR files are not installers.

**No FASK login, Node.js, Python, or separate database installation is required for the installed app.** AI answers do require an OpenAI-compatible API endpoint (and an API key if the service needs one).

## What you can do

| Capture the question | Build your knowledge |
| --- | --- |
| Mark your screen with a transparent pen/eraser overlay | Organize records as **Profile → Workspace → Project** |
| Choose exactly which screen region to include | Read streamed answers with **Markdown and LaTeX** |
| Attach an image or text/code files | Search questions, add notes, and link concepts |
| Continue a conversation without leaving your screen; follow-ups stay in one question | Explore a concept graph and export memory as Markdown |

## Getting started

### 1. Connect AI

FASK works with any **OpenAI-compatible API** (the `/v1/models` and `/v1/chat/completions` endpoints), such as the OpenAI API or a compatible gateway or local server.

1. Open FASK **Settings · AI connection** and enter the endpoint, for example `https://api.openai.com/v1` or `http://127.0.0.1:8317/v1`.
2. Enter the **API key** if the service requires one. It is stored encrypted with the OS credential store and is never included in backups.
3. Select **Check connection · Load models**, choose default/fast/deep-reasoning models, and save.

Local browsing and manual organization work without an AI connection.

### 2. Set your capture area

Choose a monitor and rectangle in **Capture area**. Move the box or resize it from its eight handles; the selected area stays sharp and the outside is dimmed.

The editor and pen overlay use the same full-monitor coordinate space, including the taskbar area. The dotted pen-mode boundary represents the configured capture region.

The monitor and area are saved only when you press **Apply** in the editor. If the saved monitor disappears or its size changes, screen questions, follow-ups and the shortcut lead to **Set capture area again** instead of silently capturing the whole screen; your draft and attachments are kept. Applying a different monitor or size clears only the old pen marks.

### 3. Ask from your screen

Open a project, select **Ask from screen**, and mark anything relevant. Choose **Include screen capture**, then press **Ask**.

- The screen is captured **when you send**, not when you toggle capture or refine a question.
- Failed API requests keep your pen strokes and question draft. Strokes clear after successful completion.
- Answers support bold, italic, lists, code, tables, and LaTeX in the live panel, saved details, and dashboard previews.

### Android companion

In desktop **Settings → Mobile connection**, enable the hub and select a reachable LAN or Tailscale address, or turn on the relay server to connect from outside without Tailscale (the relay only forwards end-to-end encrypted bytes). Scan its QR in the Android app. Keep the PC running; the phone uses its current profile and AI connection. Treat the QR as a password. Reset pairing to revoke existing phones.

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
- **Optional AI:** independently enable question refinement, model recommendation/automatic selection, concept organization, and automatic titles. A new question gets an AI title generated in parallel with its answer from the question text, image, and attached files; renaming it yourself always wins. Automatic concept organization makes an additional model request: what the question asks becomes its tags, concepts the answer drew on are listed as related, and terms that are not concepts yet stay candidates until another question uses them. Relations are kept only with a quoted answer sentence. The tidy review proposes folding, merging, renaming, and re-judging tags, and moving questions that fit another workspace; nothing changes until you approve it. Important questions can provide context for later questions in the same project.
- **Tidy review:** inspect candidate names before calling the model. The input-token estimate is character count divided by three; output tokens are excluded. Jobs continue on the workspace's owning PC after you close the dialog. Reopen completed proposals from desktop **Notifications**. Checked changes are applied; unchecked changes are skipped for now and offered next time. The trash action, **Keep as is**, records a review without changing the item.
- **Knowledge managers on linked PCs:** linking alone does not allow tidying another PC's workspaces. Request the role in the tidy dialog; the owner can accept or reject it in Notifications, or grant/revoke it under **Settings → Connect another PC → Linked PCs**. Phones follow their connected PC's permissions. Manager grants survive restarts, but running and unreviewed proposals live only in the owner's memory and are lost on host restart. This device's persisted notification watches report interrupted jobs.
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
| AI requests | Sent to the OpenAI-compatible endpoint you configure; local storage does **not** mean offline AI |

Raw answers are preserved as Markdown. No separate classroom backend is needed.

---

## Developer guide

> For modifying FASK or running from source. Ordinary users should use the **Releases installer** above.

### Run from source

Prerequisites: **Node.js 22.13+**, npm, and an OpenAI-compatible API endpoint if you want model responses. SQLite is provided by Electron's built-in `node:sqlite`; no Python or database server is needed.

```powershell
git clone https://github.com/KyungMinseo1/FASK.git
cd FASK/desktop
npm ci
npm run dev
```

The development version runs the same personal app from source. This does not replace the AI connection setup in [Getting started](#getting-started).

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

The integrated smoke uses a local fake OpenAI-compatible server and a deterministic capture fixture, not a real provider account or unrelated desktop content. Multi-monitor/DPI configurations and per-account image support still need environment-specific verification.

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
mobile/                      Capacitor Android companion app
relay/                       Cloudflare relay for end-to-end encrypted remote access
graphify-out/                Code graph analysis output
```

</details>

> MCP, embedding search, and JEV are future scope, not current features.
