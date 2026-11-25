# Changelog

All notable changes to FASK. Add new entries under `## [Unreleased]`; `npm run version:bump -- X.Y.Z` moves them into that version's section (replacing `{{version}}` with the version), and pushing the tag puts the section at the top of the GitHub Release notes, followed by download links and the auto-generated PR list. Open a section with a launch headline `## 🚀 FASK v{{version}} "Codename" is here!`, a one- or two-sentence pitch of the release, then `### ✨ Added`, `### 🔧 Changed`, `### 🐛 Fixed` as needed. Add a `> [!WARNING]` block only when users must act. Write entries in English without Korean; refer to UI text by its English translation in `desktop/src/shared/i18n/en/*.json`.

## [Unreleased]

## 🚀 FASK v{{version}} "Habit Forming" is here!

FASK now notices how you like answers formatted and starts doing it on its own, and the text and files you were about to send stay put when you switch screens or a send fails.

### ✨ Added
- **Answer habit candidates**: a formatting wish you mention (for example asking for LaTeX, a table, or a shorter explanation) first becomes a candidate and is not applied yet. Settings → Answer habits shows them in a new **Candidates** group with progress ("Requested in n/3 conversations") and **Promote** / **Ignore** buttons.
- **Automatic promotion**: a candidate turns on by itself once you have asked for it in 3 different conversations, or right away when you ask directly ("from now on", "always"). The bell then shows "Answers will now follow: …" with **OK** / **Turn off**, so you can still confirm or turn it off.

### 🔧 Changed
- **Every request is judged by the model**: the local keyword filter that blocked many real format requests is gone; typos are judged by meaning. Long requests are sent as their first and last 250 characters, so an instruction at the end is kept.
- Habit detection now runs in batches across questions: as soon as 8 unchecked requests are pending, or once no new answer has arrived during the extraction delay; leftovers run at startup. Each batch stays within one project, so one project's habits never leak into another.
- Up to 30 candidates are kept (the least-requested, oldest one is dropped first), and habits you turned off are matched instead of coming back as new candidates.
- The separate candidate approval notification is removed; the bell only shows habits that turned on by themselves.
- **Past requests are re-checked once**: on first start after the update, all earlier requests are scanned again under the new rules (8 per call, one call at a time, using your configured model).

### 🐛 Fixed
- **Desktop drafts keep their attachments**: images and files attached in the overlay composer are no longer lost when the panel closes (pen, eraser, collapse, outside click) or after a trip to the dashboard. Unsent attachments are kept until the app restarts.
- **Mobile drafts survive leaving the screen**: text and attachments in the new-question and question-detail composers and the overlay stay while the app runs; they are cleared when you unpair or leave the demo.
- Text you already sent no longer comes back in the composer when the panel was closed or you continued the conversation while the answer was still streaming.
- A failed send puts your text and files back into the composer (only when you haven't written a new draft meanwhile).
- The dashboard's new-question composer stays in sync with the overlay's draft instead of showing stale content.
- Concept error messages now say "workspace" instead of the old terminology.

## [1.3.1] - 2026-11-21

## ✨ FASK v1.3.1: see your whole workspace at a glance

Concept graphs now reach across projects: switch from one project to the whole workspace, on the desktop and on your phone, and see where each concept comes from.

### ✨ Added
- **Workspace concept graph**: a project's concept graph can switch to the whole workspace's graph, on desktop and in the mobile app (opened from Home when the workspace has concepts). It shows every concept in the workspace with how many questions across projects link to it, and a project filter highlights one project's concepts.
- The mobile workspace graph shows concept details, supports graph editing and opens in a resizable sheet, using the same graph components as the desktop.

### 🔧 Changed
- A concept's linked questions are grouped by project, and concepts from shared projects carry a badge so it is clear what comes from shared workspaces.

## [1.3.0] - 2026-11-19

## 🚀 FASK v1.3.0 "One of Me" is here!

One profile per PC, with its own keys, habits and usage. Linked PCs now see only the workspaces you share and answer with their own AI, and every question shows who asked it.

> [!WARNING]
> Linked PCs share no workspaces after this update. On the host PC, open Settings → 기기 연결 and choose which workspaces each linked PC may see. Both PCs need this version to ask in each other's workspaces.

### ✨ Added
- **Profile page**: the profile card at the top of the sidebar opens it. 기본 설정 holds the name, a picture (six patterns, colors from the app themes), this PC's name and token usage; 보안 holds the PIN lock.
- **Usage history**: a GitHub-style year of daily tokens (model plus Jev); hover a day for its numbers and Jev cost. Days where the API reported no usage are estimated from text length and marked.
- **PIN lock** (6–12 digits): locks this PC's app screens and encrypts the model and Jev keys a second time with a key from the PIN. It locks on demand, when Windows locks and on sleep; repeated wrong PINs make you wait longer. Forgetting the PIN can reset it, which deletes the keys and keeps your questions. The question database itself is not encrypted, and linked devices can still read what is shared while the PC is locked.
- **Who asked**: every new question turn records the asker's profile name, picture and device (or "phone connected to …"), shown on the turn, also on the host PC.
- **Choose what each linked PC sees**: in Settings → 기기 연결, 공유 범위 picks the workspaces per linked PC; a new link shares none, and a notification asks the host to choose. Making a pairing code first asks you to confirm what a linked PC can do.
- When a share or a link is removed, that PC's running answers, extraction and tidy stop at once, and the linked PC drops the removed workspaces from its screen and its saved drafts (on its next connection if it was offline).
- **In-app updates (Windows)**: FASK checks GitHub Releases on start and every 6 hours, downloads a newer version in the background and shows "새 버전 … 준비되었습니다" in notifications. 업데이트하기 installs it silently and restarts the app; nothing installs without that click. Versions before this one need one manual install of the new setup file.

### 🔧 Changed
- **One profile per PC**: adding, switching and deleting profiles is gone; separate your work with workspaces. Profiles from earlier versions stay hidden until you press 합치기 in the notification, which moves their workspaces into this profile (clashing names get the old profile's name) after an automatic backup.
- **A question uses the asking device's AI**: a question in a linked PC's workspace is routed and answered with your PC's model, keys and Jev, as are its title, search keywords, knowledge search and concept extraction; tidy by a knowledge manager runs on the manager's PC. The workspace's PC only builds the prompt from its knowledge and stores the result. Turns asked by a PC that is offline wait and are extracted when it reconnects.
- **Answer habits are per profile and learned on the asker's device**, from that profile's own turns only, with a separate model request after concept extraction. A habit applies to every project or to one project (also another PC's project); a project habit can explicitly replace a general one there. Workspace-scoped habits from earlier versions now apply to every project. A conflicting habit whose scope you didn't state is only suggested.
- Backups no longer contain settings, and restoring adds the backup's workspaces to this profile instead of creating a new one.
- Settings → 기기 연결: the mobile pairing QR code and the relay server address stay hidden until you open them; the QR hides again after two minutes.
- The phone's offline copy no longer stores other PCs' workspaces.

### 🐛 Fixed
- A linked PC could view any of the host's images and stop the host's own answers; it can now only see images of shared questions and cancel its own answers.
- A Jev request could override the fixed Jev model.


## [1.2.1] - 2026-11-16

### ✨ Added
- **Jev connection**: Settings → AI → Jev 연결 connects TypeSafe's decision model Jev with a TypeSafe key (default) or an OpenRouter key; no environment variables needed. 연결 확인 checks the key with one minimal request. The key is encrypted with the OS keystore (as the local access key is), stays on this PC, and is never sent to the screen, backups or the phone. Two switches, both on by default and active only with a saved key: model routing and knowledge search.
- **Jev model routing**: while you type, the composer shows the local rule; once typing pauses for 1 second, Jev judges whether the question is simple or needs multi-step reasoning and the recommendation shows a "Jev 판단" chip. The verdict is cached, so sending the same text makes no second request. In Auto, sending without a cached verdict asks Jev and falls back to the local rule after 3 seconds; Manual never asks Jev. Linked-PC and phone composers keep the local-rule preview.
- **Jev knowledge search** (DecisionRAG): reference knowledge for answers is found by Jev reading a table of contents (projects and topic concepts), opening the promising branches, scoring their questions and concepts, and comparing the best five, so it can find related records that share no keyword with the question. Keyword (BM25) hits join as extra candidates. If Jev fails, the keyword search is used as before.
- `npm run test:jev` runs real Jev API tests with `TYPESAFE_API_KEY` from the shell; without it they are skipped.

### 🔧 Changed
- **Answer model choice is simpler**: Settings → AI 연결 → 답변 모델 선택 is either 자동 선택 or 직접 선택. The Jev switch and when it judges sit right under it: after a 1, 2 or 3-second pause in typing, or only on send (one Jev request per question).
- In Auto, the composer shows one line with the model that will answer, the judged complexity and who judged it (Jev, the local rule, or decided on send), plus reasoning effort. There is no model picker until you press 직접 선택, which picks a model for that question only; 자동으로 returns to Auto. In 직접 선택 mode the picker is always on that line.
- The Recommend mode is gone; saved settings and backups that use it open as Auto. A model picked with 직접 선택 skips routing on the answering PC, so no Jev request is made for it.

## [1.2.0] - 2026-11-15

## 🚀 FASK v1.2.0 "Remember Me" is here!

Your answer style, learned once and applied everywhere. Plus knowledge exports you can shape and take anywhere, from a linked PC or your phone.

### ✨ Added
- **Answer habits**: FASK picks up feedback about answer format, length, structure, tone or notation (for example "수식은 LaTeX로") and applies it to later answers. It checks at the same time as concept extraction; a new habit is suggested in notifications ("기억" / "무시"), while ones you ask for directly ("앞으로", "항상") apply right away and can be turned off from the notification. One-time requests and content questions are ignored.
- Settings → 답변 습관: turn the feature on or off, and review, add, edit, turn off or delete habits. Each habit has a rule, optional situation keywords (empty means all answers) and a scope (whole profile or one workspace). Habits can be saved to a `.json` file and imported on another profile or PC. Habits are included in backups.
- Mobile: the answer habits on/off switch in settings.
- **Export options**: choose what the knowledge export zip contains: questions and answers (off exports only the concept graph), your notes, screenshots (with a count) and approved relations only.
- Exporting a linked PC's project fetches the zip from that PC over the encrypted connection and saves it on this device. This PC must be approved there as a knowledge manager.
- Mobile: export a project's knowledge archive from the project screen and choose where to save the ZIP.

### 🔧 Changed
- The export dialog's "이미지 포함" checkbox is replaced by the content options above.

## [1.1.9] - 2026-11-12

### Added
- **Expandable question panel**: the overlay question panel can expand to fill the screen and shows the whole recent question; Restore returns to its previous size and position.
- **Referenced-question panels**: clicking a referenced question in the overlay opens it read-only beside the question panel (up to three) instead of rebuilding the overlay, so pen marks and the current conversation stay. Drag the corner to resize one; the next opens at that size. "Follow up in this conversation" switches the panel to it in place. They hide and return with the question panel (outside click, the question shortcut or the toolbar's 질문 button) at the same place, size and scroll position.
- **Reasoning effort**: the composer has a 추론 강도 picker (모델 기본값, 낮음, 보통, 높음), sent to the local API as `reasoning_effort` and remembered for the next question.
- **Resizable question note**: drag the handle between the question list and the note to resize it (double-click resets), or expand the note to the full width; both are remembered. Narrow or portrait windows, such as one snapped to half the screen with Win+←/→, show the list or the open note one at a time.
- Mobile: "이 대화에 이어서 질문" on a question starts the screen-question overlay on that conversation; a running overlay session restarts on it.
- Mobile: referenced questions in the screen-question overlay open read-only inside the panel; "대화로 돌아가기" returns to the same spot, and "이 대화에 이어서 질문" switches the panel to that question with pen marks kept.
- **Notification history**: handled notifications fade out of the list and are kept per device under "지난 내역" (accepted, rejected, applied, reviewed, dismissed, with tidy result counts). The bell opens straight to history when nothing is new, and the popover closes itself after the last new item is handled.
- **Resizable, collapsible sidebar**: drag the desktop sidebar's right edge to resize it (200–360px, double-click resets), or collapse it from the button beside the logo; both are remembered. While collapsed, the expand button and the notification bell sit at the start of the breadcrumb.
- **Copy LaTeX**: block math in answers has a copy button that copies its TeX source.
- Long-pressing a movable graph node shows a ring that fills until the node can be dragged.
- Mobile: the notification center, with a bell on the home and project screens that opens a bottom sheet. Tidy jobs started on the phone now notify too.

### Changed
- The question note keeps "Follow up in this conversation", Concepts and Notes in a bar pinned to the top while scrolling; concepts and notes open from it instead of sitting below the last turn.
- The floating ↑☆✕ controls of a question note now sit just below the pinned bar, which takes the full width.
- Mobile: tablets in portrait show the question list or the open question one at a time.
- The composer labels the answer model, says which model answers in Auto and Recommend modes, reuses the last model you picked, and shows the model while it writes. Each saved answer shows the model that actually answered. "Save only" was removed.
- Linked-PC projects offer that PC's answer models in the composer (following its Auto and Recommend modes) and remember the pick per PC. A linked PC on an older build still answers with its own model settings.
- Mobile: the composer's 파일 첨부, 촬영 and 사진 buttons are now one "파일·사진 첨부" button that opens a menu to take a photo, choose an image or choose a file.
- Question lists show 10 questions per page instead of 20.
- A tidy plan with nothing to change shows a single "확인" in its notification instead of opening an empty review dialog.
- The notification popover was redesigned with icons, tabs and a close button.

### Fixed
- A new question asked on a linked PC's project, from this PC or from the phone, no longer fails with "현재 프로필에서 항목을 찾을 수 없습니다."
- Dashboard search and filter stay visible when the project header is collapsed.
- Mobile: screens no longer run under the Android navigation bar, so the "새 질문" button and the conversation scroll controls stay tappable instead of triggering Back.
- Mobile (wide layout): the question list scrolls with no question open, question cards have spacing between them, and the list and conversation columns end on the same line.
- Mobile: the pinned note bar no longer slips under the top edge, and the model picker and note bar buttons are full touch size again.
- Copying selected text that contains math pastes each formula once as `$…$` TeX, instead of twice as plain and italic text.
- Long-pressing the root or "미분류" graph node no longer shows the drag hint.

## [1.1.8] - 2026-11-10

FASK 1.1.8 lets you choose Korean or English AI prompts, moves settings into a categorized page, and fixes screen questions capturing the wrong monitor.

### Added
- **Korean and English AI prompts**: choose the language FASK uses for answers, refinements, titles, search and knowledge extraction, on desktop and mobile. Korean stays the default.
- **Categorized settings page**: the desktop settings modal became a full page grouped by category, with guidance for each model role and clearer icons.

### Fixed
- Stale monitor settings no longer make screen questions capture the wrong display. Saving capture settings now requires picking a monitor and pressing Apply, and missing or resized displays lead you through recovery without losing your draft.
- Pen marks are cleared only when you switch to a different monitor or screen size.

### Other
- Settings and error messages now describe any OpenAI-compatible local API, not one specific proxy.
- GitHub Releases now open with the matching CHANGELOG notes.
- Added the MIT license.

## [1.1.7] - 2026-11-09

### Added
- **Workspace concept graph**: concepts and relations are extracted from questions and answers into a workspace-wide three-level graph (topics, concepts, details), viewable on desktop and mobile.
- **Graph tidy suggestions**: background reviews propose retagging, folding, candidate promotion, renames, relation cleanup and question moves for you to approve, with a notification when they finish.
- **Question tags vs. supporting concepts**: core and background concepts are kept apart, and relations are only created when the answer supports them.
- **Project export**: export project knowledge as a ZIP containing JSONL and SKOS.
- Image-aware memory search and smoother graph dock interactions.
- Linked-PC manager permissions let owners decide whether remote PCs may run graph tidy-ups.

### Fixed
- Invalid concept items from the model are rejected, and weakly supported relations stay pending.
- Redundant parent-child relations are prevented.
- Relation overlays are replaced by focused highlights and navigable neighborhood graphs.

### Other
- Existing data is migrated to the new three-level concept model; backups and exports keep tidy-suggestion state.

## [1.1.6] - 2026-11-06

### Added
- **Ask from linked-PC projects**: overlay follow-ups and "Ask on screen" work on projects from another PC. The shortcut opens the project last viewed in the dashboard, and linked-PC workspaces are marked with 🌐 in the overlay project picker.
- **Foldable question history**: the question panel header shows "New conversation" or the continued question's title, earlier turns fold away, and jump controls (top, star, turn list, bottom) were added.
- Screen questions always start fresh; while continuing a thread, a bar with a "+ New question" button is shown.
- Refreshed icons and themes across the overlay panel and the home, new question, project and settings screens.

### Fixed
- Relay reconnects open the new stream before closing the old one, so the connection no longer drops.
- A failed snapshot request while the stream is live shows cached data instead of going offline.
- Opening a project that is no longer linked shows "Project not found".
- The overlay toolbar is back to 64px.

## [1.1.5] - 2026-11-04

### Added
- Turn navigation (TurnNav) inside question threads, and expandable/collapsible questions.
- The overlay blinks when an answer finishes; this can be turned off in Settings.

## [1.1.4] - 2026-11-03

### Added
- **Multilingual UI**: mobile app and Android overlay text is translatable, and the language setting syncs with the native overlay.
- **Demo mode**: explore the mobile app with sample projects, concepts and questions without pairing a PC.

## [1.1.3] - 2026-11-02

### Added
- **Pair with a code**: pair the mobile app using the 8-character device code shown on the PC.
- **New themes**: Sepia, Forest and Rose.
- The mobile Connection screen became a Settings screen that holds both theme and connection settings.

## [1.1.2] - 2026-11-02

### Added
- Copy answers.
- Question position is remembered so you can keep asking while watching the screen.
- The question prompt focuses more closely on what you marked with the pen.
- Cloudflare relay configuration for remote connections.

## [1.1.1] - 2026-10-29

### Added
- Move questions to another project from the dashboard and mobile.
- The mobile app retries failed connections and can preview the overlay from Settings.

### Other
- Pushing a tag now publishes the Windows installer and a signed Android APK automatically.

## [1.1.0] - 2026-10-28

### Added
- **Personal hub**: the desktop app stores questions and answers as a hub, and the mobile companion app pairs with it to browse and ask.
- **Themes**: system, light and dark themes with the Pretendard font.
- **Overlay project picker**: switch projects directly from the overlay.

### Other
- Older databases are migrated to the new structure, and backup validation is stricter.

## [1.0.9] - 2026-10-22

### Added
- First FASK release: mark the screen with a pen, ask AI, and keep questions and answers per project.
- Restarting the app clears recent conversations while keeping records and settings.

## [1.0.3] - 2026-10-03

Pre-FASK release of ASKKUP.

### Fixed
- Improved overlay behavior on macOS.

## [1.0.2] - 2026-10-03

### Fixed
- Cleaned up macOS build entitlements and app icons.

## [1.0.1] - 2026-10-03

### Added
- Deleting a course also deletes its student questions and materials.

## [1.0.0] - 2026-10-03

### Added
- First ASKKUP release: teachers open courses and sessions and collect student questions, with session reopening, student question memos and recall quizzes.
