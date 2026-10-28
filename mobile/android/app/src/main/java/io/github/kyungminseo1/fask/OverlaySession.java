package io.github.kyungminseo1.fask;

import android.content.Intent;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;

/** Process-local only. All access is serialized on the Android main thread. */
final class OverlaySession {
    enum State { IDLE, AWAITING_CONSENT, STARTING, ACTIVE, STOPPING, STOPPED }
    interface StartResult {
        void active(String sessionId);
        void failed(String code, String message);
    }
    interface CaptureRequest { void capture(OverlayCaptureController.Callback callback); }

    static OverlaySession current;
    static String revokedFingerprint;

    final String id = UUID.randomUUID().toString();
    final String profileId;
    final String projectId;
    final String questionId;
    final String[] addresses;
    final int port;
    final String fingerprint;
    private String token;
    private final List<StartResult> starts = new ArrayList<>();
    private final List<Runnable> stops = new ArrayList<>();
    State state = State.IDLE;
    long epoch;
    Intent consent;
    int consentResult;
    Runnable stopResources;
    CaptureRequest captureRequest;

    OverlaySession(String[] addresses, int port, String fingerprint, String token,
                   String profileId, String projectId, String questionId) {
        this.addresses = addresses.clone();
        this.port = port;
        this.fingerprint = fingerprint;
        this.token = token;
        this.profileId = profileId;
        this.projectId = projectId;
        this.questionId = questionId;
        this.activeQuestionId = questionId;
    }

    /** Continuation target set by the panel after a turn is identified; null means a new question. */
    String activeQuestionId;

    /** Bearer for this session's native requests only; never sent to the panel. */
    String token() { return token; }

    boolean sameContext(OverlaySession other) {
        return profileId.equals(other.profileId) && projectId.equals(other.projectId)
            && java.util.Objects.equals(questionId, other.questionId)
            && fingerprint.equals(other.fingerprint) && token.equals(other.token)
            && port == other.port && Arrays.equals(addresses, other.addresses);
    }

    void awaitConsent() {
        if (state != State.IDLE) throw new IllegalStateException("Session already started");
        state = State.AWAITING_CONSENT;
        epoch++;
    }

    boolean isCurrent(long expectedEpoch) {
        return current == this && epoch == expectedEpoch
            && state != State.STOPPING && state != State.STOPPED;
    }

    void addStart(StartResult result) {
        if (state == State.ACTIVE) result.active(id);
        else if (state == State.AWAITING_CONSENT || state == State.STARTING) starts.add(result);
        else result.failed("CLOSED", "화면 질문이 종료되었습니다.");
    }

    boolean beginStarting(long expectedEpoch) {
        if (!isCurrent(expectedEpoch) || state != State.AWAITING_CONSENT) return false;
        state = State.STARTING;
        return true;
    }

    boolean activate(long expectedEpoch) {
        if (!isCurrent(expectedEpoch) || state != State.STARTING) return false;
        state = State.ACTIVE;
        List<StartResult> pending = new ArrayList<>(starts);
        starts.clear();
        for (StartResult result : pending) result.active(id);
        return true;
    }

    void stop(String code, String message, Runnable completion) {
        if (state == State.STOPPED) {
            if (completion != null) completion.run();
            return;
        }
        if (completion != null) stops.add(completion);
        if (state == State.STOPPING) return;
        state = State.STOPPING;
        epoch++;
        consent = null;
        captureRequest = null;
        token = null;
        List<StartResult> pending = new ArrayList<>(starts);
        starts.clear();
        for (StartResult result : pending) result.failed(code, message);
        Runnable release = stopResources;
        if (release != null) release.run();
        else stopped();
    }

    void stopped() {
        if (state == State.STOPPED) return;
        state = State.STOPPED;
        stopResources = null;
        consent = null;
        captureRequest = null;
        token = null;
        if (current == this) current = null;
        List<Runnable> pending = new ArrayList<>(stops);
        stops.clear();
        for (Runnable result : pending) result.run();
    }
}
