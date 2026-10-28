# FASK 개인용 구현

2026-10-28. 개인용 데스크톱과 Android 동반 앱의 실행 계약이다. 기존 수업용 `server/`는 제거했으며 Python, FastAPI, 별도 서버 DB는 사용하지 않는다.

## 실행 구조

- `App.tsx`는 개인용 대시보드, `/personal-overlay`, `/capture-editor`만 실행한다. 기존 교사·학생 인증·수업·리콜 화면과 `window.askkup` preload API는 삭제했다.
- main의 `personal.ts`가 SQLite, 로컬 API, 파일 대화상자, 백업을 담당한다. renderer는 `window.fask`의 제한된 preload 메서드만 사용한다.
- OpenAI 호환 Chat Completions 스트리밍을 사용한다. 공급자 로그인과 프록시 내부 라우팅은 EasyCLIProxyAPI의 책임이다.
- `node:sqlite`를 사용한다. 검증한 Electron 39.8.10의 Node 22.22.1에는 DatabaseSync가 포함되어 있다.
- `fask.sqlite`는 WAL·외래 키 설정을 켜고 `schema_migrations`, `records`, `preferences`, `runs`를 보유한다. 현재 스키마 버전은 2이며 1.0.x 질문은 대화별 `Question.turns`로 마이그레이션한다.
- 프로필은 한 DB의 profile scope로 구분한다. 이미지 파일은 내용 해시로 공유하되 접근은 현재 프로필의 질문 참조를 확인한다. 이는 OS 사용자 격리/DB 전체 암호화와 다르다.
- 작은 원본 레코드는 JSON payload로 보관한다. 초기 검색은 현재 프로젝트의 원문·전송 문장·답변·메모에 대한 부분 문자열 검색이다. FTS와 임베딩은 아직 사용하지 않는다.

## IPC 와이어 계약

타입 정본은 `desktop/src/preload/personal.d.ts`이며 renderer `api/types.ts`에서도 re-export한다. 기존 수업용 서버 스키마와 REST 경로는 제거되었으며 개인용 앱의 계약이 아니다.

| IPC 채널 (`personal:` 접두사) | 입력 | 결과 |
|---|---|---|
| snapshot | 없음 | 현재 프로필의 Snapshot과 이번 앱 실행의 recentQuestions(projectId → questionId), 키 원문 제외 |
| create | profile/workspace/project/concept, 이름, 상위 ID | 새 ID |
| rename | profile/workspace/project/concept/question, ID, 새 이름 | 이름 변경. 질문은 선택적 title만 변경하며 raw/refined/sent 보존 |
| remove | 같은 항목 종류, ID | 범위 검사 후 연쇄 삭제. 실행 중 요청·오버레이가 있으면 거절 |
| clear-recent | 프로젝트 ID | 이번 앱 실행의 해당 프로젝트 최근 대화 초기화 |
| edit-overlay-region | 없음 | 현재 오버레이 모니터의 영역 편집. 적용·취소 후 오버레이 복귀 |
| active-project | 프로젝트 ID | 단축키로 열 대상 프로젝트 선택 |
| overlay-regions | drawing boolean, 도구/패널의 DIP 사각형 배열, panelOpen boolean(질문 패널 또는 프로젝트 팝오버가 열림) | 메인 프로세스의 네이티브 커서 위치 판정과 포커스 해제에 사용 |
| shortcut-info | 없음 | 등록한 accelerator 또는 null, fallback 여부 |
| switch-profile | 프로필 ID | 완료. 요청·캡처 창이 있으면 거절 |
| save-settings | LocalSettings, 선택적 새 접속 키 | 완료. 키 생략은 유지, 빈 문자열은 제거 |
| models | endpoint, 선택적 키 | 모델 ID 목록 |
| ask | requestId를 포함한 AskInput | `{questionId, turnId}`. 같은 요청 ID와 같은 내용은 기존 실행을 반환하며 내용 충돌은 거절 |
| cancel / run-state | 요청 ID 또는 turn ID / questionId, turnId | 현재 프로필 실행 취소 / revision을 포함한 TurnState |
| refine | 원문, 선택적 이미지 | 다듬은 문장. 자동 전송하지 않음 |
| update-question | 질문 ID, memo/important/conceptIds/suggestions | 완료 |
| edit-concept / merge-concept | 개념 ID와 변경/대상 | 완료. 다른 프로젝트·트리 순환 거절 |
| attachment / clear-attachment | 이미지 ID / questionId, turnId | data URL / 해당 turn의 첨부 제거 |
| displays | 없음 | 모니터 ID·이름·DIP 크기 |
| open-editor / preview | 모니터 ID / 없음 | 편집 창 / 고정 화면 미리보기 |
| save-region / close-editor | CaptureRegion / 없음 | 영역 적용 / 취소 |
| open-overlay / capture | 프로젝트 ID + 선택적 질문 ID / 선택적 펜 PNG | 지정 대화의 질문 패널을 오버레이로 열기 / 잘린 이미지 data URL |
| dashboard | 없음 | 오버레이를 닫고 대시보드 복귀 |
| export | 프로젝트 ID | Markdown 저장 대화상자, 저장 여부 |
| backup / restore | 없음 | JSON 백업/새 프로필 복원 대화상자, 성공 여부 |

이벤트 `personal:stream`은 requestId, questionId, turnId, revision과 delta 또는 done/error를 전달한다. 클라이언트는 revision으로 중복·역순 이벤트를 배제하고 재연결 후 run-state로 최종 답변을 복구한다. `personal:changed`는 스냅샷 재조회 신호, `personal:escape`는 펜 모드 해제, `personal:toggle-panel`은 질문 패널을 여닫는 신호이다. 오류는 IPC Promise 거절이며 UI는 접속 키·모델·한도·시간 초과 등을 표시한다.

2026-10-22 수정: `personal:outside-click`은 캡처를 위한 일시 숨김을 제외한 오버레이의 포커스 이탈 신호다. renderer는 펜/드래그 모드를 해제하고 질문 패널만 닫는다. 패널이 열려 있으면 단순 mouseleave로 닫지 않는다. 패널이 닫힌 유휴 상태에는 도구 밖에서 오버레이 자신의 포커스를 해제하며 임의의 외부 앱을 강제 활성화하지 않는다.

화면 캡처 전 모든 보이는 FASK 창을 숨기며 Windows 오버레이·편집 창은 캡처 제외로 생성한다. 편집 미리보기나 이전 캡처가 다시 찍히는 것을 방지하고 끝나면 원래 창의 표시·포커스 상태를 복원한다. 캡처 포함 체크의 명시적 선택은 프로필별로 기억한다. 질문 저장 ID 반환만으로 펜을 지우지 않고 답변 성공 완료 후 지운다. API 실패 시 펜과 질문 초안을 유지한다.

캡처 영역 편집 창과 펜 오버레이는 공통 창 생성 경로에서 OS 전체화면으로 연다. 일반 창의 작업영역 제한(작업표시줄 제외) 때문에 표시 좌표가 실제 캡처 좌표와 달라지지 않도록, 두 viewport를 모니터 전체 DIP 크기에 맞춘다. 편집 미리보기·선택 사각형·펜 모드의 점선 안내는 모두 이 전체 모니터 좌표계를 사용한다.

대시보드 답변 미리보기는 원문을 자르지 않고 상세·실시간 답변과 같은 Markdown/KaTeX 파이프라인으로 렌더링한 뒤 CSS로 높이를 제한한다. 굵게·기울임·수식을 지원하며 CSP는 폰트에 한해서 `data:`를 허용한다.

개념 그래프는 질문 필터와 루트 트리를 메모이즈한다. 이름 변경 대화상자 등 그래프와 무관한 UI 상태 변경으로 노드를 다시 구성하지 않으며, fitView는 최초 초기화·펼침 상태 변경에만 수행한다.

2026-10-21 UI 수정: 상위 경로는 HashRouter 검색 파라미터를 이용한 실제 내 공간/워크스페이스/프로젝트 탐색이며 뒤로가기를 지원한다. 워크스페이스·프로젝트 이름은 현재 프로필 범위를 검사한 후 수정한다.

오버레이는 DOM hover 이벤트에 의존하지 않는다. ResizeObserver로 보고한 도구·패널 영역과 메인 프로세스에서 30ms 간격으로 읽는 DIP 커서 좌표를 비교해 클릭 통과 여부를 바꾼다. 펜/지우개 모드에는 전체 캔버스가 입력을 받는다. 축소된 도구의 버튼 클릭과 나머지 화면의 클릭 통과를 함께 검증한다.

도구에는 별도 '선택' 버튼이 없다. 펜/지우개 모드에서 우클릭(그리는 도중의 우클릭 포함) 또는 Esc를 누르면 진행 중인 획을 확정하고 클릭 통과로 돌아간다. 우클릭 자체는 배경 앱에 전달되지 않고 오버레이의 기본 컨텍스트 메뉴도 막는다. 도구 맨 아래 '프로젝트' 팝오버는 워크스페이스별 프로젝트 목록을 보여 주며, 선택하면 창을 다시 만들지 않고 hash의 `project`와 `personal:active-project`만 바꾼 뒤 질문 패널을 연다. 펜 필기는 유지하고 이전 프로젝트 초안은 프로젝트별 localStorage에 남는다. 패널의 Composer가 전송 중이거나 결과 불명일 때는 목록을 비활성화한다. 답변 스트림만 진행 중이면 원래 프로젝트에 계속 저장된다.

팝오버가 열린 동안에는 축소된 도구의 임시 펼침(peek)을 유지한다. 팝오버는 질문 패널처럼 overlay-regions의 panelOpen으로 보고되어 커서가 도구를 벗어나도 포커스를 놓지 않으므로, 배경을 클릭하면 blur → `personal:outside-click`으로 닫힌다. 오버레이 안의 다른 곳을 누르거나 Esc를 눌러도 닫힌다. 도구를 벗어날 때 main이 하는 포커스 해제(`win.blur()`)는 Windows의 최상위 오버레이에서 아무 효과 없이 끝날 수 있다. 이때 창이 여전히 포커스를 가지면 해제 표식을 바로 지워, 다음 실제 바깥 클릭이 무시되지 않게 한다.

단축키는 `Ctrl+Shift+Space` 등록 성공 여부를 검사하고 실패 시 `Ctrl+Alt+Space`를 시도한다. 실제 등록 상태를 사이드바에 표시한다. 동작은 현재 프로젝트 오버레이 열기/질문 패널 토글이며, 펼쳐질 때 입력란에 포커스를 둔다.

`Turn.documents`는 선택적 `{name,text}[]`이다. 이미지 파일·클립보드는 PNG로 변환하고 attachment 경로를 이용한다. 텍스트 파일은 UTF-8·개수·크기를 검사한 뒤 별도 참조 데이터로 모델에 전달하며 각 turn에 보존한다. 상세·검색·내보내기·백업에서도 이용한다. 지원하지 않는 PDF/바이너리는 조용히 무시하지 않고 오류를 표시한다.

main은 등록된 앱 창의 main frame만 허용한다. API 요청은 main에서 수행하고 외부 리디렉션을 따르지 않는다. endpoint는 localhost/127.0.0.1/::1만 허용한다. 접속 키는 Electron safeStorage로 암호화해 저장하고 백업/Markdown에는 포함하지 않는다.

## 질문·그래프·기억

- 원문, 선택적 다듬은 문장, 전송 문장, 답변, 복잡도, 추천 근거, 요청/응답 모델, 상태를 저장한다.
- 전송 전에 질문과 실행 이력을 저장한다. 부분 답변을 주기적으로 기록하며 앱 재시작 시 진행 중이던 요청을 실패 상태로 복구한다.
- 같은 대화의 완료된 이전 질문 최대 8개를 참고한다. 기억 설정을 켜면 같은 프로젝트의 중요 표시한 기록 최대 5개를 추가한다. 답변/메모는 길이를 제한해 전송한다.
- 모델 추천은 로컬 규칙이며 빠른/깊은 추론 모델 매핑을 사용한다. 이미지 난이도는 미확정으로 표시한다. 구독의 실제 잔여 한도는 FASK가 조회하지 않으며 프록시에서 확인한다.
- 자동 정리는 답변 후 별도 요청으로 기존 개념 ID와 새 개념 제안을 받는다. 연결 대상은 현재 프로젝트의 실제 ID인지 검증한다. 새 개념은 사용자가 클릭해야 생성한다. 작업 중 사용자 연결을 수정했으면 자동 결과가 덮어쓰지 않는다.
- 그래프는 기존 MindMap을 재사용한 개념 트리이다. 질문 하나를 여러 개념에 연결할 수 있으며 각 개념 아래에서 같은 질문을 연다. 개념 이름·상위 위치·병합을 편집할 수 있다.
- Markdown에는 원본 질문·AI 답변·사용자 메모를 구분한다. 외부 세션의 자동 동기화나 기존 ChatGPT/Claude 대화 조회는 제공하지 않는다.
- 1.0.5: 실시간 답변과 질문 상세는 react-markdown/remark-gfm으로 제목·목록·표·코드를 렌더링한다. 원문은 그대로 보존한다. HTML을 실행하지 않고 위험한 링크를 필터링하며 외부 이미지 자동 로딩도 하지 않는다.
- 질문 패널은 고정된 외곽 크기와 내부 스크롤을 분리한다. 토글이 있는 화면 사분면의 반대쪽 모서리에 작은 손잡이를 두고 폭/높이를 조절한다. 맞은편 모서리는 고정한다. 프로필별 크기, 프로필·화면 크기별 패널 위치와 토글 위치를 로컬에 기억한다. f 로고를 드래그해 토글을 옮긴다. 드래그/리사이즈 동안 네이티브 입력을 유지하고 완료 후 도구 영역 기반 클릭 통과로 돌아간다. 질문 버튼은 hover와 무관하게 강조색을 유지한다.

## 캡처

- 설정에서 선택 모니터를 고정 미리보기로 만들고 선택 박스 안은 선명하게, 밖은 blur/dim으로 표시한다.
- 박스 이동, 8방향 핸들, 적용/취소/초기화/전체 화면, Enter/Esc를 제공한다.
- 모니터 ID와 정규화 사각형, 설정 당시 화면 크기를 저장한다. 모니터가 없거나 화면 크기가 바뀌면 재설정을 요구한다.
- 실제 질문 캡처는 새 화면을 사용한다. 오버레이를 숨기고 캡처한 후 펜 캔버스 좌표를 실제 이미지 크기에 맞추어 합성하고 영역을 자른다. 선택 범위 밖 픽셀과 편집 UI는 반환하지 않는다.
- 1.0.5: 질문 패널에서는 캡처 포함 여부만 체크한다. 최종 질문 전송을 누른 뒤 캡처를 한 번 수행하고 바로 전송한다. 체크 변경·질문 다듬기·저장만 동작에서는 촬영하지 않는다. 다듬기 검토가 켜져 있으면 검토를 마친 최종 전송에서 촬영하며, 화면만 보내는 질문은 다듬기를 생략한다. 캡처 실패 시 질문을 전송하지 않고 입력을 유지한다. 이미지 첨부와 화면 캡처는 한 장 제한에 따라 상호 전환한다.
- 최소: 답변 성공 후 보관 이미지를 제거한다. 실패·저장만 한 질문은 이미지를 유지한다.
- 균형: 영역 JPEG quality 90. 보존: 영역 PNG. 썸네일은 화면에서 원본을 축소 표시한다.
- 이미지 제거 시 다른 질문/프로필의 참조가 있으면 파일을 유지한다. 보존 기간·용량 상한에 따른 자동 삭제는 아직 제공하지 않는다.

## 후속 범위

프로젝트별 설정 재정의, Responses 프로토콜 선택, FTS/임베딩 검색, 일반 관계 그래프, 읽기 전용 MCP, JEV, 기존 수업 DB 가져오기는 후속 구현이다. 현재 프로필별 설정과 Chat Completions 경로를 사용한다.

실제 EasyCLIProxyAPI 계정 연결·상위 모델 이미지 지원·사용량은 사용자 endpoint에서 별도 검증해야 한다. 통합 테스트는 테스트용 프록시와 앱 화면 fixture로 실행하며 실제 공급자 인증을 사용하지 않는다.

## 검증 결과

- `npm run typecheck`, `npm run build`: 통과.
- 변경된 main/preload/개인용 renderer와 MindMap의 ESLint 오류 검사: 통과.
- `npm test`: 7개 통과. 재시작 복구·이름 변경 보존·프로필/프로젝트 범위·개념 순환 방지·이미지 공유 참조·첨부파일 형식/크기·백업 참조 검증·인증/분할 SSE/한글/연결 중단/취소를 검증한다.
- `npm run test:smoke`: 실제 Electron에서 상위 경로/뒤로가기·이름 변경 UI·이미지 붙여넣기/Markdown 드롭·첨부 저장·OS 단축키 등록·단축키 콜백·축소 도구 네이티브 마우스 클릭·배경 클릭 통과를 기존 캡처/백업 흐름과 함께 확인한다. 단축키 하드웨어 입력 대신 등록 상태와 실제 콜백 동작을 검사하며, 커서 좌표는 테스트 fixture를 주입한다.
- 1.0.5 통합 검증: 포함 체크/다듬기에서는 캡처 호출이 없고 전송 시 한 번 촬영하는지, 캡처 제외 전송에는 이미지가 없는지 확인했다. Markdown 제목/코드/표 렌더링, 위험 HTML/링크 차단, 긴 답변 내부 스크롤과 네이티브 마우스 리사이즈를 함께 검증했다.
- 7개 화면 이미지를 생성해 대시보드·상세·그래프·설정·첨부 입력·캡처 편집·오버레이 레이아웃을 확인했다. 테스트 결과와 화면은 `desktop/tests/`의 무시된 출력 경로에 있다.
- Windows 폴더 배포 파일: `desktop/dist/win-unpacked/FASK.exe`. 폴더 전체가 필요하다.
- Git 명령은 실행하지 않았다. 기존 서버 DB와 공급자 계정 설정은 수정하지 않았다.


## 1.0.6 편집·오버레이 상태

- 프로필/워크스페이스 선택기, 프로젝트 항목/카드, 날짜순·목록 질문, 그래프의 프로젝트·개념·질문 노드에 우클릭 메뉴를 제공한다. 편집은 이름 바꾸기이며 `Question.title?: string`은 최대 200자이다. 원문·전송 문장·답변을 바꾸지 않고 제목/검색/그래프/내보내기에 반영한다. 이전 백업도 호환된다.
- 질문 삭제는 해당 요청 이력과 이미지 참조를 제거한다. 프로젝트 삭제는 하위 질문·개념, 워크스페이스 삭제는 하위 프로젝트, 프로필 삭제는 모든 소속 기록·접속 키·설정을 한 SQLite 트랜잭션으로 제거한다. 마지막 프로필을 지우면 빈 기본 프로필을 만든다. 이미지 파일은 모든 프로필에서 마지막 참조가 사라진 뒤 지운다. 개념 삭제는 질문을 보존하고 연결을 해제하며 자식 개념을 상위로 올린다. 진행 중인 요청이 있으면 먼저 마치거나 중지해야 한다.
- 최근 대화 ID는 main의 메모리에만 보관한다. 패널 접기·대시보드 왕복 후 최근 질문과 Markdown 답변을 복원하되 앱을 완전히 재시작하면 새 질문 화면으로 시작한다. 원래 질문 기록은 SQLite에 남는다. 대시보드 상세의 이어서 질문은 선택한 질문의 대화를 오버레이에서 연다.
- 화면 캡처 포함 선택은 프로필별 localStorage에 기록해 패널/앱을 다시 열어도 유지한다. 위치·크기 역시 localStorage이며 백업의 학습 기록과는 분리한다. 나가기 버튼 자리는 캡처 영역 설정으로 대체했다. 편집하는 동안 오버레이를 숨기고 종료하면 같은 오버레이로 복귀한다.
- 대시보드의 보라색 f 로고를 build/icon.png, icon.ico, icon.icns, resources/icon.png에 반영했다. 재생성 소스는 build/generate-icons.cjs이다.
- Electron 통합 검증은 우클릭 이름 변경·실제 삭제, 최근 질문/답변 복원, 네 사분면 토글 드래그와 손잡이 방향·고정점, 대시보드 왕복 위치·크기·캡처 선택 복원, 오버레이에서 캡처 편집 후 복귀를 포함한다. 별도 Electron 프로세스로 완전히 재시작해 최근 대화 초기화와 저장 기록·캡처 선택·두 위치 복원을 추가 확인했다.

## Android 허브와 검증 (1.1.0)

`personal-hub.ts`는 사용자가 선택한 주소의 47615 포트에만 HTTPS를 연다. `/health`, `/events`, 허용된 `/rpc/<method>`를 제공한다. 토큰은 Authorization 헤더로만 전달하며 Origin·본문 크기·메서드를 제한한다. 프로필 변경과 데스크톱 파일 대화상자는 모바일에 노출하지 않는다.

Android는 OkHttp 네이티브 플러그인으로 자체 서명 인증서의 SHA-256 지문을 고정 검증한다. 연결 비밀은 보안 저장소에, 스냅샷은 AES-GCM으로 암호화해 보관한다. 브라우저 개발 모드의 인증서 검증 생략은 APK에 적용되지 않는다. Electron BoringSSL이 빈 extensions 필드를 거절하므로 허브 인증서에는 BasicConstraints와 digitalSignature KeyUsage를 포함한다.

검증: 데스크톱 테스트 16개와 Electron smoke/restart 통과. 브라우저에서 새 질문·후속 질문, 응답 유실 후 동일 turn 재사용, 허브 중단 중 완료된 답변의 재연결 복구(관측 176ms), 오프라인 재로드의 캐시 5개 turn 표시, 토큰 초기화 후 연결 해제를 확인했다. 태블릿 1024px와 Android 세로 411px에서 가로 넘침이 없었다.

Android JDK 21에서 testDebugUnitTest와 assembleDebug 성공. Pixel_7에 실제 웹 자산을 포함한 pairing-test APK를 설치해 네이티브 TLS 연결, 질문 전송·답변 저장, 잘못된 지문의 PIN_MISMATCH, ACTION_SEND 텍스트의 작성란 전달을 확인했다. 실제 QR 카메라 스캔·사진 촬영·갤러리·이미지 공유와 물리 휴대폰/Tailscale 종단 연결은 이 검증에서 실행하지 않았다. AI 응답은 로컬 테스트 프록시를 사용했다.

### Android 화면 질문 전송·세션 계약

- Android 앱과 화면 질문 서비스는 독립적인 `HubHttpClient` 인스턴스로 기존 leaf 인증서 pin·Bearer·SSE handshake를 공유한다. Activity 종료가 서비스 연결을 닫지 않는다.
- `HubTransport<HubIdentity>`는 토큰을 JS에 전달하지 않는 서비스 panel용 계약이다. 일반 앱은 `Pairing`과 암호화 `SnapshotCache`를 계속 사용한다. 캐시를 생략한 client는 마지막 성공 snapshot만 메모리에 보관하고 close 시 버린다.
- 프로젝트의 Android 전용 시작 버튼은 캐시가 아닌 최신 허브 snapshot으로 프로필·프로젝트·질문 소속을 확인한다. 오버레이 권한 설정에서 돌아온 것만으로 시작하지 않으며, 사용자의 다시 시작과 매 세션의 전체 화면 공유 동의가 필요하다.
- 서비스는 process-local 세션 ID만 Intent로 받으며 pairing과 projection 동의는 디스크에 저장하지 않는다. foreground·projection·reader·토글 초기화가 완료되어야 ACTIVE로 응답한다. 잠금·권한 상실·시스템 공유 종료 후 자동 재시작하지 않는다.
- 토글·도구(`읽기/펜/지우개/모두 지우기/영역 선택/프로젝트 바꾸기/질문/종료`)·질문 panel은 각각 TYPE_APPLICATION_OVERLAY 창이다. 전체 화면 ink 창은 펜·지우개·영역 편집 중에만 붙으므로 읽기·panel 상태에서 아래 앱 터치를 막지 않는다. 필기와 영역은 현재 회전의 디스플레이 논리 픽셀로 저장하며 회전·밀도·reader 교체 시 무효화한다.
- '프로젝트 바꾸기'는 panel을 열고 `projectPicker` push로 목록을 펼친다. panel 헤더의 프로젝트 이름으로도 여닫는다. 목록을 열면 Composer의 자동 포커스를 해제하고 헤더로 스크롤한다. 숨겨진 panel WebView는 높이가 0이므로 첫 resize에서 한 번 더 스크롤한다. 선택하면 bridge `setProject`가 세션의 projectId를 바꾸고 activeQuestionId를 비운다(profile·pairing은 고정). Composer가 busy·running·unresolved이면 panel은 목록을 비활성화하고 네이티브는 `BUSY`로 거절한다. 필기는 유지한다. 전환한 프로젝트가 PC에서 삭제되면 기존 context 검사가 세션을 끝낸다.
- 캡처는 Composer의 실제 전송에서만 일어난다. 모든 FASK 창을 숨긴 뒤 같은 reader의 새 프레임을 받아 선택 영역만 잘라 필기를 한 번 합성하고, 2048px 이하 JPEG(품질 90)로 줄인다. 전체 프레임을 JS·파일·네트워크로 보내지 않으며 좌표 불일치·영역 없음은 전체 화면 대체 없이 실패한다.
- 질문 panel은 서비스가 소유한 WebView(`overlay.html`, `https://appassets.androidplatform.net/assets/public/`)이다. `FaskOverlayBridge` WebMessage는 해당 origin의 main frame만 받고, `/health`·허용된 `/rpc/<method>`·`/events`만 네이티브에서 pin·토큰을 붙여 호출한다. bootstrap 결과에 토큰은 없다. 401은 세션을 끝내고 취소 표식을 남겨 앱이 다음 실행·resume에서 페어링을 정리한다. PIN_MISMATCH는 페어링을 지우지 않는다.
- Composer는 보낸 AskInput 전체(requestId·이미지 bytes·생략된 questionId 포함)를 고정한다. 응답 유실·시간 초과는 거절로 보지 않고 `같은 요청 다시 확인`으로 같은 payload를 재전송한다. 거절로 간주하는 오류는 `ask`의 recordAsk 이전 검증 문구로 한정한다. 결과가 불명인 동안 입력·편집·새 대화를 잠근다. 완료된 turn에 쓰인 ink revision과 현재 revision이 같을 때만 필기를 지운다.
- 앱 연결 해제·새 페어링 저장 전에 화면 질문 세션을 먼저 종료한다.
- 검증(2026-10-28): 모바일 Vitest 45개(Composer 상태 전이 6개 포함), desktop 16개·타입 검사, Android 단위 테스트, Bitmap 합성 instrumentation 3개 통과. Pixel_7 API 37에서 실제 PC 허브(격리 프로필, 로컬 테스트 모델 프록시)와 pairing-test 수동 입력으로 연결해, 브라우저 위 토글→펜→영역 선택→질문 전송→panel 실시간 답변→같은 질문의 turn 2 저장을 확인했다. PC에 저장된 첨부는 220×290 JPEG로 IN 표식과 펜선만 있고 OUT·토글·도구·panel·IME는 없었다. panel 접기/열기 후 같은 Composer 유지, 앱 프로세스 종료 후 running=false·새 동의 필요, 알림 `종료` 후 서비스·창 잔류 없음, PC 연결 초기화 후 panel의 PIN_MISMATCH 차단 표시를 확인했다. API 34 태블릿 AVD(2560×1600)에서는 normal APK의 동의→ACTIVE→런처 위 토글→Stop만 확인했다.
- 검증(2026-10-28, 프로젝트 전환): Medium_Phone API 37 AVD에서 격리 PC 허브(두 워크스페이스)와 pairing-test APK로 토글→'프로젝트 바꾸기'→워크스페이스별 목록·✓ 표시(첫 표시에도 헤더 노출), 터치 선택 후 헤더 이름 변경·필기 유지, 전환 후 질문이 PC의 선택 프로젝트에 저장, 스트리밍 중 목록 비활성·문구 표시와 네이티브 `setProject`의 BUSY 응답, 답변 완료 후 해제, 전환한 프로젝트를 PC에서 삭제하면 세션 종료를 확인했다.
- 미검증: 토큰만 바뀐 401 경로(PC 초기화는 인증서도 바꿔 PIN_MISMATCH가 된다), API 28/33 AVD 실행(이미지·AVD만 생성), 회전·분할 화면·3버튼 내비게이션 좌표 matrix, 태블릿에서의 캡처·질문 E2E, 실제 QR 카메라 페어링, 물리 태블릿·S Pen의 palm rejection·지연, OEM 단일 앱 공유 동작, FLAG_SECURE 화면.
