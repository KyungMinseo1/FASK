# Changelog

All notable changes to FASK. Add new entries under `## [Unreleased]`; `npm run version:bump -- X.Y.Z` moves them into that version's section, and pushing the tag puts the section at the top of the GitHub Release notes, followed by download links and the auto-generated PR list. Start a section with a one-sentence summary, and add a `> [!WARNING]` block only when users must act.

## [Unreleased]

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
