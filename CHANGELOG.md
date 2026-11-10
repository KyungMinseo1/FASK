# Changelog

All notable changes to FASK. Add new entries under `## [Unreleased]`; `npm run version:bump -- X.Y.Z` moves them into that version's section, and pushing the tag puts the section at the top of the GitHub Release notes.

## [Unreleased]



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
