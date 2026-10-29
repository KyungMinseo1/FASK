# FASK CI / CD

## PR와 기본 브랜치 검증

`.github/workflows/ci.yml`은 PR 생성·추가 커밋·다시 열기, 기본 브랜치 push,
수동 실행에 대해 `validate.yml`을 호출합니다. 기본 브랜치 이름은 GitHub 저장소
정보에서 읽으므로 `main`을 하드코딩하지 않습니다.

| Check | 환경 | 검증 |
| --- | --- | --- |
| Desktop CI | Windows 2022, Node 22 | 단위 테스트, 타입 검사, Electron 빌드 |
| Mobile CI | Ubuntu 24.04, Node 22 | Mobile 패키지만 설치한 상태에서 웹 테스트·타입 검사·빌드 |
| Android CI | Ubuntu 24.04, JDK 21, SDK 36 | Capacitor 동기화, 네이티브 단위 테스트, Debug APK 빌드 |

Android는 저장소의 Gradle Wrapper 8.14.3과 AGP 8.13.0을 사용합니다.
SDK Platform 36과 Build Tools 35.0.0을 명시적으로 설치합니다.
Ubuntu에서는 Gradle 실행 스크립트의 Windows 줄바꿈을 정리하고 실행 권한을 부여합니다.
Mobile 작업에는 Desktop 소스가 필요하지만 Desktop 패키지 설치와 빌드 산출물은
필요하지 않아야 합니다. CI는 이 조건을 매번 검증합니다.

PR의 Checks 탭과 Actions 로그에서 결과를 확인할 수 있습니다.
Android 테스트 보고서와 Debug APK는 Actions Artifacts에서 7일간 내려받을 수 있습니다.
Debug APK는 정식 배포용 APK가 아닙니다. 카메라·QR·실제 PC 연결과 Electron UI
스모크는 이 워크플로의 검증 범위에 포함되지 않습니다.

보호 규칙이 없어도 CI와 배포는 실행됩니다. 단, 실패한 PR의 병합을 강제로
막거나 기본 브랜치 직접 push를 제한하지는 않습니다. 나중에 규칙을 사용할 수
있다면 실제 PR에 표시된 세 Check를 필수 검사로 등록하세요.

## Release Environment

GitHub Settings → Environments → **Release**에 아래 Secrets를 등록합니다.
이름은 대소문자를 포함해 정확히 일치해야 합니다.

- `ANDROID_KEYSTORE_BASE64`: Keystore 파일 전체를 Base64로 인코딩한 값
- `ANDROID_KEYSTORE_PASSWORD`: Keystore 비밀번호
- `ANDROID_KEY_ALIAS`: 서명 키 alias
- `ANDROID_KEY_PASSWORD`: 서명 키 비밀번호

`release.yml`의 `android-release` 작업에 `environment: Release`가 지정되어 있습니다.
Secrets는 이 작업의 서명 단계에서만 환경변수로 전달합니다. PR CI에는 전달하지
않으며 `secrets: inherit`도 사용하지 않습니다.

Keystore는 runner 임시 폴더에 복원하고 Gradle `signingConfigs.release`에 연결합니다.
서명 후 `apksigner verify`를 실행하고 APK 인증서 SHA-256이 Keystore의 지정 alias
인증서와 일치하는지도 확인합니다. 임시 키는 성공·실패 시 삭제하며 업로드하지 않습니다.
Secrets 누락·잘못된 비밀번호·서명 실패는 배포 실패로 처리합니다.

Keystore와 비밀번호는 저장소 밖에 별도로 백업하세요. 기존 정식 배포가 있다면
동일한 서명 키를 사용해야 업데이트할 수 있습니다. Debug APK에서 Release APK로
전환할 때는 키가 달라 기존 Debug 앱 제거가 필요할 수 있습니다.
키나 비밀번호를 이슈·로그·워크플로 파일에 붙여 넣지 마세요.

## 배포 절차

1. 변경을 기본 브랜치에 반영하고 CI 성공 확인
2. Desktop과 Mobile의 `package.json`, `package-lock.json` 버전을 같은 값으로 변경
3. `mobile/android/app/build.gradle`의 `versionName`도 같은 값으로 변경하고
   `versionCode`를 이전 버전 태그보다 큰 정수로 증가
4. 버전 변경도 기본 브랜치에 반영한 뒤 해당 커밋에 `v1.1.1` 같은 태그를 생성해 push
5. Actions의 Release 실행 결과와 GitHub Releases의 설치 파일 확인

태그는 `vMAJOR.MINOR.PATCH`만 지원합니다. 사전 배포 태그는 지원하지 않습니다.
현재 파일 버전은 1.1.0이므로 `v1.1.1`을 배포하려면 먼저 위 파일들을 갱신해야 합니다.

Release는 다음 검사를 거칩니다.

- 태그가 가리키는 커밋이 원격 기본 브랜치의 이력에 포함되는지 확인
- 태그와 앱·lockfile·Android 버전 일치 확인
- 해당 커밋에서 도달 가능한 이전 정식 버전 태그보다 버전과 Android versionCode가 증가했는지 확인
- 동일 커밋에 대해 세 CI 작업 재실행
- Windows NSIS 설치 파일과 서명된 Android Release APK 생성
- 두 파일이 모두 준비된 후 Draft Release에 업로드하고 공개

Android 앱이 없었던 과거 태그는 versionCode 비교에서 제외합니다.
이 검사는 기존 태그 이력을 기준으로 하므로 이전 배포 태그를 삭제하거나 이동하지 마세요.
GitHub 보호 규칙을 사용할 수 없다면 저장소 쓰기 권한과 태그 생성 권한을 신뢰하는
사람에게만 부여하세요. 기본 브랜치 포함 검사는 승인 기반 보호 규칙의 대체 수단은 아닙니다.

정식 배포 파일은 `fask-<version>-setup.exe`, `fask-<version>-android.apk`입니다.
Windows 설치 파일은 현재 코드 서명 인증서 없이 생성합니다.
기존 macOS 수동 빌드 워크플로는 별도로 유지합니다.

배포 파일을 만드는 작업은 읽기 권한만 사용하고 마지막 업로드 작업에만
`contents: write`를 부여합니다. 저장소 또는 조직 정책에서 Actions의 Release 쓰기를
허용해야 합니다. 서명·패키징 작업은 PR 캐시를 복원하지 않습니다.

업로드가 실패하면 Draft가 남을 수 있습니다. 원인을 수정한 뒤 같은 실행을 재실행하면
Draft에 파일을 다시 올려 공개합니다. 이미 공개한 Release는 덮어쓰지 않습니다.
앱 수정이 필요하면 버전을 올리고 새 태그로 배포하세요.

## 로컬에서 Android Release 빌드

`ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`를 프로세스 환경변수로 설정한 뒤 Mobile 동기화와
`assembleRelease`를 실행합니다. 경로는 절대 경로를 권장합니다.
서명 설정 없이 실행한 `assembleRelease`는 실패하며, `assembleDebug`는 키 없이 실행됩니다.

## 공식 참고 문서

- [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [Android AGP 8.13 compatibility](https://developer.android.com/build/releases/agp-8-13-0-release-notes)
- [Android apksigner](https://developer.android.com/tools/apksigner)
