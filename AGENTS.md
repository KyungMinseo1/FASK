# Repository Guidelines

## 프로젝트 개요

FASK는 화면 위에 펜으로 표시하고 AI에게 질문한 뒤, 답변을 프로젝트와 개념 그래프로 쌓는 개인용 학습 도구입니다. 투명 오버레이에서 화면을 표시·캡처해 질문하고, 질문과 답변은 프로필 > 워크스페이스 > 프로젝트 단위로 로컬에 저장됩니다.

## 아키텍처

데스크톱은 Electron 앱(React, TypeScript)이며 메인 프로세스가 로컬 SQLite 저장소, 화면 캡처, 단축키, OpenAI 호환 로컬 API(EasyCLIProxyAPI) 연결을 담당합니다. 모바일 동반 앱은 데스크톱 허브에 페어링해 같은 데이터를 보고 질문하며, 원격 연결은 Cloudflare 중계 서버가 암호화된 데이터만 전달합니다.

## 저장소 구조

`desktop/`은 Electron 앱(electron-vite, React, Tailwind), `mobile/`은 Capacitor Android 동반 앱, `relay/`는 Cloudflare 중계 서버입니다. 모바일은 데스크톱의 `personal.css`와 `personal/theme.ts`를 그대로 가져다 씁니다. 디자인 기준은 루트 `DESIGN.md`입니다. `docs/`는 로컬 전용(gitignore)이며 기준 문서로 참조하지 않습니다.

## 실행·검증

- 데스크톱: `cd desktop && npm run dev`, 타입체크 `npm run typecheck`, 단위 테스트 `npm test`, 질문 노트·오버레이 레이아웃 E2E `npm run test:ui`
- 모바일: `cd mobile && npm run typecheck`, 테스트 `npm test`, 디버그 APK `npm run apk`
