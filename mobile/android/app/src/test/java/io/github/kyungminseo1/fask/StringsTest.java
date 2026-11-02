package io.github.kyungminseo1.fask;

import static org.junit.Assert.*;
import org.junit.Test;

public class StringsTest {
    @Test public void koreanIsTheDefaultAndPassesThrough() {
        assertEquals("ko", Strings.normalize(null));
        assertEquals("ko", Strings.normalize("fr"));
        assertEquals("en", Strings.normalize("en"));
        assertEquals("모두 지우기", Strings.translate("ko", "모두 지우기"));
    }

    @Test public void englishTranslatesKnownKeysAndFallsBackToKorean() {
        assertEquals("Clear all", Strings.translate("en", "모두 지우기"));
        assertEquals("Screen question stopped.", Strings.translate("en", "화면 질문을 종료했습니다."));
        assertEquals("Pen color 3", Strings.translate("en", "펜 색상 {{n}}").replace("{{n}}", "3"));
        assertEquals("미등록 문장", Strings.translate("en", "미등록 문장"));
    }

    @Test public void sharedMessageConstantsHaveEnglish() {
        for (String ko : new String[]{OverlayCaptureController.CLOSED_MESSAGE, OverlayCaptureController.GEOMETRY_MESSAGE,
            OverlayCaptureController.FULL_DISPLAY_MESSAGE, OverlayWebBridge.UPDATE_WEBVIEW}) {
            assertNotEquals(ko, Strings.translate("en", ko));
        }
    }
}
