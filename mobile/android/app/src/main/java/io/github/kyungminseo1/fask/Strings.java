package io.github.kyungminseo1.fask;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.HashMap;
import java.util.Map;

/**
 * Native overlay UI text. Korean is the source language and doubles as the key (same convention as
 * the web i18n resources); English entries fall back to the Korean key when missing.
 * Messages that also travel to JS stay Korean there; only native surfaces (labels, toasts,
 * notifications) translate them here.
 */
final class Strings {
    static final String PREFS = "overlay_language";
    static final String KEY = "lang";

    private static final Map<String, String> EN = new HashMap<>();
    static {
        // Toolbar, handle and popovers (OverlayChrome)
        EN.put("FASK 화면 질문 메뉴", "FASK screen question menu");
        EN.put("FASK 토글", "FASK toggle");
        EN.put("FASK 도구", "FASK tools");
        EN.put("FASK 선택", "FASK picker");
        EN.put("펜", "Pen");
        EN.put("지우개", "Eraser");
        EN.put("모두 지우기", "Clear all");
        EN.put("질문", "Ask");
        EN.put("질문 · 앱 열기", "Ask · open app");
        EN.put("대시보드", "Dashboard");
        EN.put("캡처 영역", "Region");
        EN.put("캡처 영역 선택", "Select capture region");
        EN.put("프로젝트", "Project");
        EN.put("프로젝트 바꾸기", "Change project");
        EN.put("종료", "Stop");
        EN.put("FASK 화면 질문 종료", "Stop FASK screen question");
        EN.put("펜 색상 {{n}}", "Pen color {{n}}");
        EN.put("손가락으로도 그리기", "Draw with finger too");
        EN.put("손가락과 펜 모두 필기됩니다", "Both finger and pen draw");
        EN.put("S펜만 필기 · 손가락은 화면 조작", "Only the S Pen draws · finger controls the screen");
        EN.put("PC에서 프로젝트를 만들어 주세요.", "Create a project on your PC.");
        // Panel and ink windows (OverlayWindowController, OverlayInkView)
        EN.put("FASK 편집", "FASK editor");
        EN.put("FASK 질문", "FASK question");
        EN.put("FASK 캡처 전환", "FASK capture transition");
        EN.put("화면 질문", "Screen question");
        EN.put("접기 ×", "Hide ×");
        EN.put("질문 창 접기", "Hide question panel");
        EN.put("질문 창 너비 조절", "Resize question panel");
        EN.put("FASK 펜 및 캡처 영역 편집", "FASK pen and capture region editor");
        EN.put("취소", "Cancel");
        EN.put("확인", "OK");
        EN.put("드래그하여 영역 선택 · 가장자리로 크기 조절", "Drag to select a region · drag the edges to resize");
        // Notification and toasts (OverlaySessionService, OverlayPlugin preview)
        EN.put("FASK 화면 질문 사용 중", "FASK screen question is on");
        EN.put("토글 또는 알림에서 화면 공유를 종료할 수 있습니다.", "Stop screen sharing from the toggle or this notification.");
        EN.put("앱 열기", "Open app");
        EN.put("앱을 열 수 없습니다.", "Couldn't open the app.");
        EN.put("미리보기: 앱 열기", "Preview: open app");
        // Session stop reasons, toasted natively once the session is active
        EN.put("화면 구성이 바뀌었습니다. 영역을 다시 선택해 주세요.", "The screen layout changed. Select the region again.");
        EN.put("화면 잠금으로 화면 질문을 종료했습니다.", "Screen question stopped because the screen locked.");
        EN.put("다른 앱 위에 표시 권한이 해제되었습니다.", "Permission to display over other apps was turned off.");
        EN.put("화면 공유가 종료되었습니다.", "Screen sharing ended.");
        EN.put("화면 구성이 바뀌어 화면 질문을 종료했습니다. 앱에서 다시 시작해 주세요.",
            "Screen question stopped because the screen layout changed. Start it again from the app.");
        EN.put("화면 질문 서비스가 종료되었습니다.", "The screen question service stopped.");
        EN.put("화면 질문을 종료했습니다.", "Screen question stopped.");
        EN.put("잠금을 해제하고 앱에서 다시 시작해 주세요.", "Unlock your phone and start again from the app.");
        EN.put("다른 앱 위에 표시 권한이 필요합니다.", "Permission to display over other apps is required.");
        EN.put("화면 공유 초기화에 실패했습니다. 앱에서 다시 시작해 주세요.", "Couldn't start screen sharing. Start again from the app.");
        EN.put("화면 질문 창을 표시할 수 없습니다.", "Couldn't show the question panel.");
        EN.put("화면 위 토글을 표시할 수 없습니다.", "Couldn't show the on-screen toggle.");
        EN.put("Android System WebView를 업데이트해 주세요.", "Please update Android System WebView.");
        EN.put("질문 창이 비정상 종료되어 화면 질문을 종료했습니다.", "Screen question stopped because the question panel crashed.");
        EN.put("페어링이 해제되었습니다. 앱에서 다시 연결해 주세요.", "Pairing was removed. Reconnect from the app.");
        EN.put("화면 공유가 종료되었습니다. 앱에서 다시 시작해 주세요.", "Screen sharing ended. Start again from the app.");
        EN.put("전체 화면 공유로 다시 시작해 주세요.", "Start again and share the entire screen.");
        EN.put("화면 프레임을 갱신할 수 없습니다. 앱에서 다시 시작해 주세요.", "Couldn't refresh the screen frame. Start again from the app.");
        EN.put("화면 프레임을 읽을 수 없습니다.", "Couldn't read the screen frame.");
        EN.put("화면 질문 창을 복원할 수 없습니다.", "Couldn't restore the question panel.");
    }

    private Strings() {}

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** 'ko' (default) or 'en'. */
    static String language(Context context) {
        return normalize(prefs(context).getString(KEY, "ko"));
    }

    static String normalize(String lang) {
        return "en".equals(lang) ? "en" : "ko";
    }

    static String get(Context context, String ko) {
        return translate(language(context), ko);
    }

    static String translate(String lang, String ko) {
        if (!"en".equals(lang)) return ko;
        String en = EN.get(ko);
        return en == null ? ko : en;
    }
}
