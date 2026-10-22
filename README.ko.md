# FASK — 개인용 화면 질문과 지식 공간

[English](README.md) | **한국어**

데스크톱 앱은 로그인 없이 사용하는 개인용 버전입니다. 프로필 → 워크스페이스 → 프로젝트로 질문을 분류하고, 투명 오버레이에서 펜으로 표시한 화면과 함께 질문합니다. 기존 수업용 서버는 제거했습니다.

## 개인용 앱 실행

```powershell
cd desktop
npm ci
npm run dev
```

Node.js 22.13 이상을 사용하세요. Electron 내장 `node:sqlite`로 저장하므로 Python이나 별도 DB 설치는 필요하지 않습니다.

1. EasyCLIProxyAPI에서 사용할 계정을 연결하고 로컬 프록시를 시작합니다.
2. FASK의 **설정 · AI 연결**에서 OpenAI 호환 Local API endpoint를 입력합니다. 예: `http://127.0.0.1:8317/v1`.
3. 프록시가 요구하면 **로컬 접속 키**를 입력합니다. 공급자 API 키나 관리용 키와 구분하세요.
4. **연결 확인 · 모델 불러오기** → 기본/빠른/깊은 추론 모델 선택 → **설정 저장**.
5. **캡처 영역 설정**에서 모니터와 사각형 범위를 정합니다. 안쪽은 선명하게, 바깥은 흐리게 표시되며 박스 이동과 8방향 크기 조절을 지원합니다.
6. 프로젝트에서 **화면에서 질문**을 누르고 펜/지우개로 표시한 뒤 질문 패널에서 **화면 캡처 포함** 여부를 선택합니다. **질문하기**를 누르면 그 시점의 설정 영역을 캡처해 질문과 함께 전송합니다. 체크를 바꾸거나 질문을 다듬을 때에는 촬영하지 않습니다.

질문 다듬기, 모델 추천/자동 선택, 개념 정리는 각각 켜고 끌 수 있습니다. 설정의 자동 개념 정리는 답변 뒤 추가 모델 요청을 사용하며, 새 개념은 제안으로 표시됩니다. 중요 표시한 질문은 같은 프로젝트의 이후 질문에 참고됩니다.

오버레이에서 Esc는 펜 모드를 해제합니다. `Ctrl+Shift+Space`는 현재 프로젝트의 화면 질문을 열고, 오버레이가 있으면 질문 패널을 여닫습니다. 다른 앱이 이 키를 점유하면 `Ctrl+Alt+Space`를 대체 키로 등록하며 사이드바에 실제 사용 가능한 키를 표시합니다. 질문 버튼은 평소에도 진한 색으로 강조됩니다. 질문 패널은 헤더로 이동하고 오른쪽 아래 손잡이를 드래그해 크기를 조절할 수 있으며, 조절한 크기는 기억합니다. 긴 답변은 패널 내부에서 스크롤합니다.

답변은 실시간 패널·저장된 질문 상세·대시보드 미리보기 모두에서 Markdown 굵게·기울임·제목·목록·인용·코드 블록·표·LaTeX 수식으로 표시합니다. 원본 답변은 Markdown 텍스트로 보존합니다.

다른 앱을 클릭하면 해당 앱의 포커스를 유지하면서 질문 패널을 닫습니다. 열린 패널에서 마우스만 벗어났을 때에는 닫지 않습니다. 패널이 닫히고 펜이 유휴 상태일 때 도구 밖으로 나가면 FASK 자신의 키보드 포커스를 해제하며 다른 앱을 강제로 활성화하지 않습니다. 캡처 영역 설정은 FASK 창을 제외한 현재 화면을 새로 촬영합니다. API 요청 실패 시 펜 획과 질문 초안을 유지하며, 성공 완료 후에만 펜을 지웁니다. 캡처 포함 여부의 명시적 선택은 프로필별로 기억합니다.

상단 경로의 **내 공간 / 워크스페이스 / 프로젝트**를 클릭하면 상위 목록으로 돌아갈 수 있고, 왼쪽 화살표로 이전 화면에 돌아갑니다. 워크스페이스 선택 아래의 **이름 변경**, 프로젝트 제목 옆 **연필 버튼**으로 이름을 수정할 수 있습니다.

대시보드와 오버레이의 새 질문은 **파일·이미지** 버튼, 드래그 앤 드롭, 이미지 붙여넣기를 지원합니다. 이미지는 1장(PNG/JPEG/WebP/GIF), 텍스트/Markdown/코드 파일은 최대 5개(파일당 50,000자, 합계 100,000자)를 첨부할 수 있습니다. PDF 등의 바이너리 문서는 현재 지원하지 않으며 지원하지 않는 파일은 오류로 안내합니다.

대시보드에서 날짜순/목록/개념 그래프, 텍스트 검색, 복잡도 필터, 메모와 개념 연결을 사용할 수 있습니다. **기억 내보내기**는 다른 AI 세션에 첨부할 Markdown을 생성합니다. 설정의 백업은 이미지가 포함된 JSON이며 복원은 별도 프로필을 만듭니다. 접속 키는 백업하지 않습니다.

개인 데이터는 Electron `userData/personal/fask.sqlite`, 이미지는 `userData/personal/attachments/`에 저장됩니다. Windows 기본 위치는 `%APPDATA%/fask/personal/`입니다. 프로필은 DB 안에서 논리적으로 구분됩니다.

## 파일 구조

```
desktop/                     Electron 앱 (electron-vite, React, TypeScript, Tailwind)
  src/main/                  메인 프로세스
    index.ts                 앱 진입점, 메인 창
    profile.ts               --profile 플래그 → 별도 userData 폴더
    personal.ts              IPC 핸들러(personal:*), 저장소·API·캡처 연결
    personal-store.ts        node:sqlite 저장소(레코드, 설정, 실행 기록, 마이그레이션)
    personal-capture.ts      투명 오버레이, 캡처 영역 편집기, 화면 캡처
    personal-shortcuts.ts    전역 단축키 등록과 대체 키
    personal-backup.ts       JSON 백업·복원
    local-api.ts             OpenAI 호환 Local API 클라이언트(스트리밍, 모델 목록)
  src/preload/               window.fask 브리지와 타입(personal.d.ts)
  src/renderer/src/
    App.tsx                  라우트: 대시보드, /personal-overlay, /capture-editor
    personal/                대시보드, 오버레이, 입력창, 설정, 캡처 편집기,
                             Markdown 답변, 첨부, 펜 획
    components/MindMap/      개념 그래프(React Flow + d3-hierarchy)
    lib/, api/types.ts       트리 구성, 질문 유형, 공용 타입
  tests/                     단위 테스트(npm test)와 Electron 스모크 테스트
  build/, resources/         아이콘, macOS entitlements, 아이콘 생성 스크립트
docs/                        개인용 계획과 현재 구현 계약
graphify-out/                코드 그래프 분석 결과
```

## 검증과 패키징

```powershell
cd desktop
npm test
npm run typecheck
npm run build
npm run test:smoke
npm run build:unpack
```

`test:smoke`는 실제 Electron 창과 테스트용 로컬 프록시를 사용합니다. 캡처 원본은 테스트 앱 화면으로 대체하므로 다른 앱 화면이나 실제 구독 계정을 전송하지 않습니다. Windows 실제 화면 캡처 권한·다중 모니터·연결 계정별 이미지 지원은 사용자 환경에서 추가 확인해야 합니다.

설계는 [개인용 계획](docs/PERSONAL_APP_PLAN.md), 현재 구현 범위와 IPC 계약은 [개인용 구현 문서](docs/PERSONAL_IMPLEMENTATION.md)를 참고하세요. MCP, 임베딩 검색, JEV는 후속 범위입니다.

