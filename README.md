# FASK — Personal On-Screen Questions and Knowledge Space

**English** | [한국어](README.ko.md)

The current desktop app is a personal, login-free edition. Questions are organized as Profile → Workspace → Project, and you ask them together with a screen region you have marked up with a pen on a transparent overlay. The legacy FastAPI server does not need to run.

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

Answers are rendered as Markdown (headings, lists, quotes, code blocks, tables, and LaTeX math) both in the live panel and in saved question details. The raw answer is kept as Markdown text.

Clicking **My space / Workspace / Project** in the breadcrumb returns to the parent list, and the left arrow goes back to the previous screen. Rename a workspace with **Rename** under the workspace selector, and a project with the **pencil button** next to its title.

New questions on the dashboard and overlay support the **Files·Images** button, drag and drop, and image paste. You can attach 1 image (PNG/JPEG/WebP/GIF) and up to 5 text/Markdown/code files (50,000 characters per file, 100,000 total). Binary documents such as PDF are not supported yet; unsupported files produce an error message.

The dashboard offers chronological/list/concept-graph views, text search, a complexity filter, notes, and concept linking. **Export memory** generates Markdown you can attach to another AI session. Backups in Settings are JSON including images; restoring creates a separate profile. Access keys are not backed up.

Personal data is stored in Electron `userData/personal/fask.sqlite`, images in `userData/personal/attachments/`. The default location on Windows is `%APPDATA%/fask/personal/`. Profiles are separated logically inside the database. The legacy server's `askkup.db` is not modified.

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
server/                      Legacy ASKKUP FastAPI server (not used by the app)
docs/                        Personal app plan/implementation docs, legacy PLAN.md
references/                  Legacy hackathon material
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

---

# Legacy ASKKUP (질문, 잇다) server reference

The following describes the classroom server preserved in this repository. It is not required to run the current personal desktop app.

A learning-support app in which AI refines questions students have during class and delivers them to the teacher **anonymously**.

- **Student**: join with a class code → mark the screen with a pen on a transparent overlay or type a rough question → confirm the AI-refined question ("Is this what you mean?") and submit → view your questions as a mind map by topic and type
- **Teacher**: upload a syllabus (PDF) and lecture materials (PDF/PPTX) → weekly concept maps are generated and editable → open a session (6-digit code) → see questions live as concept/type maps and a chronological chat

See [docs/PLAN.md](docs/PLAN.md) for the detailed design (Korean).

macOS users: see [README.macOS.md](README.macOS.md) (Korean).

## Layout

The legacy student/teacher desktop screens have been removed; only `server/` remains. Desktop steps ② and ③ below no longer apply to the current app.

```
server/   Python FastAPI server + SQLite + AI integration, pytest tests
docs/     design documents, demo syllabus
```

## Prerequisites

| Tool | Version | Purpose |
| --- | --- | --- |
| [uv](https://docs.astral.sh/uv/) | 0.11+ | Server virtualenv and dependency management |
| Python | 3.11 | Server (installed automatically by `uv` if missing) |
| Node.js / npm | 22 / 10 | Desktop app |

Install uv (pick one):

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
# or
pip install uv
```

## 1. Create the server virtualenv

```bash
cd server
uv sync
```

`uv sync` creates the `server/.venv` virtualenv and installs dependencies (including dev-only pytest) from `pyproject.toml`/`uv.lock`. If Python 3.11 (`server/.python-version`) is missing, uv downloads it.

Run later commands with `uv run <command>` to use the virtualenv automatically. To activate it manually:

```powershell
# PowerShell
server\.venv\Scripts\Activate.ps1
# Git Bash
source server/.venv/Scripts/activate
```

## 2. Install desktop dependencies

```bash
cd desktop
npm install
```

## 3. Environment variables

### Server — `server/.env` (AI API keys)

```bash
cd server
cp .env.example .env
```

The server reads the **`.env` in the directory it is started from**, so keep it inside `server/` and start the server from `server/`. `.env` is read only at startup; restart the server after editing it.

There are three AI roles, and each can use a different provider.

| Role | Purpose |
| --- | --- |
| `QUESTION_LLM_*` | Refining student questions and judging inappropriate content (image input) |
| `CURRICULUM_LLM_*` | Syllabus analysis, weekly concept generation (web search), question classification |
| `EMBEDDING_*` | Question–concept similarity candidates (`none` classifies with the LLM only) |

If `*_API_KEY` is empty, the provider's shared key (`OPENAI_API_KEY` / `GEMINI_API_KEY`) is used. `*_BASE_URL` is only needed for vLLM.

**OpenAI** (default)

```env
JWT_SECRET=a-random-string-of-at-least-32-chars
OPENAI_API_KEY=sk-...
QUESTION_LLM_PROVIDER=openai
QUESTION_LLM_MODEL=gpt-6-luna
CURRICULUM_LLM_PROVIDER=openai
CURRICULUM_LLM_MODEL=gpt-6-luna
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
```

**Gemini**

```env
JWT_SECRET=a-random-string-of-at-least-32-chars
GEMINI_API_KEY=AIza...
QUESTION_LLM_PROVIDER=gemini
QUESTION_LLM_MODEL=gemini-3.8-flash
CURRICULUM_LLM_PROVIDER=gemini
CURRICULUM_LLM_MODEL=gemini-3.8-flash
EMBEDDING_PROVIDER=gemini
EMBEDDING_MODEL=gemini-embedding-001
```

**vLLM** (OpenAI-compatible server)

```env
QUESTION_LLM_PROVIDER=vllm
QUESTION_LLM_BASE_URL=http://localhost:8001/v1
QUESTION_LLM_MODEL=Qwen/Qwen2.5-VL-7B-Instruct
CURRICULUM_LLM_PROVIDER=vllm
CURRICULUM_LLM_BASE_URL=http://localhost:8001/v1
CURRICULUM_LLM_MODEL=Qwen/Qwen2.5-VL-7B-Instruct
EMBEDDING_PROVIDER=vllm
EMBEDDING_BASE_URL=http://localhost:8002/v1
EMBEDDING_MODEL=BAAI/bge-m3
```

Notes:

- Replace model names with ones available to your account (e.g. OpenAI `gpt-5.4-mini`).
- If you get a `reasoning_effort` error, clear `QUESTION_LLM_REASONING_EFFORT=` (an empty value is not sent).
- For models without vision support, set `QUESTION_LLM_SUPPORTS_IMAGES=false`.
- Web search: OpenAI uses the `web_search` tool, Gemini uses Google Search, vLLM uses DuckDuckGo.

Connection check (optional, from `server/`):

```bash
uv run python -c "import asyncio; from app.config import Settings; from app.ai.llm import build_ai_clients; from app.ai.structured import RefineResult; c=build_ai_clients(Settings()); print(asyncio.run(c.question.json('질문을 다듬어라','회귀 분류 차이?',RefineResult))); print(len(asyncio.run(c.embedder.embed(['회귀']))[0]))"
```

It works if a refined question and the embedding dimension are printed.

### Desktop — `desktop/.env` (optional, server address)

The app's default server address is `http://localhost:8000`. For a different port or PC:

```env
VITE_API_BASE_URL=http://localhost:1111
```

This is applied at build time, so restart `npm run dev` or re-run `npm run build` after changing it. You can also change it under "Server address" on the login screen (saved only when you press Login, remembered per profile; a saved address takes precedence over `.env`).

## 4. Running

Use three terminals.

**① Server**

```bash
cd server
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

If you change the port, update both `--port` and the app's server address. The DB and uploads are created automatically in `server/data/`.

**② Teacher app**

```bash
cd desktop
npm run dev
```

**③ Student app** — to use teacher and student on one PC, run a build with a separate profile so login state does not mix.

```bash
cd desktop
npm run build
npx electron . --profile=student
```

Students on other PCs should set the server address to `http://<server PC IP>:<port>` (the port must be allowed in the server PC's firewall).

## 5. Usage flow

1. **Teacher**: sign up and choose the **Teacher** role (default is Student) → create a course → upload a syllabus PDF (demo: `docs/인공지능개론/노해선_인공지능개론01_강의계획서_16주차.pdf`) → week tabs and concept maps are generated
2. **Teacher** (optional): upload weekly lecture materials (PDF/PPTX), edit concepts, add banned words
3. **Teacher**: `Open session` → choose a week → a 6-digit session code is shown
4. **Student**: sign up (Student) → enter the session code → the transparent overlay appears (clicks pass through to other apps)
5. **Student**: mark the screen with the pen (optional) + type a question → `Refine question` → `Yes, submit` (`No` asks for changes and rewrites)
6. **Teacher**: questions appear live on the concept/type maps and the chat on the live screen (student identity is not shown)
7. **Student**: open `Dashboard` in the toolbar to view your questions by topic and type

## 6. Tests and checks

```bash
cd server && uv run pytest -q        # server tests (fake AI, no API key needed)
cd desktop && npm run typecheck      # type check
cd desktop && npm run lint           # lint
```

## Troubleshooting

- **"Email already registered" after deleting it from the DB**: the DB runs in WAL mode, so recent changes live in `askkup.db-wal`. If you deleted it in a GUI tool, make sure you saved (committed) and that the viewer does not ignore `-wal`. To delete reliably:
  ```bash
  cd server
  uv run python -c "import sqlite3; c=sqlite3.connect('data/askkup.db'); c.execute('PRAGMA foreign_keys=ON'); c.execute(\"delete from users where email='user@to-delete'\"); c.commit()"
  ```
- **Reset all data**: stop the server, delete `server/data/`, and start the server again (this deletes everything, including uploads).
- **Syllabus analysis / week generation fails**: check the API key and model name, restart the server, then re-upload the syllabus or press `Regenerate` on the week. The cause is logged in the server terminal.
- **Port permission error (Windows)**: check reserved ports with `netsh interface ipv4 show excludedportrange protocol=tcp` and use another port.
