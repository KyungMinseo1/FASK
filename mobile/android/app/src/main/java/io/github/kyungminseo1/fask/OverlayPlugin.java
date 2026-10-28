package io.github.kyungminseo1.fask;

import android.Manifest;
import android.app.Activity;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.media.projection.MediaProjectionConfig;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import org.json.JSONArray;

@CapacitorPlugin(name = "FaskOverlay", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public final class OverlayPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private PluginCall permissionCall;
    private boolean settingsLeft;
    private OverlaySession pending;
    private long pendingEpoch;
    private boolean consentOutstanding;
    private boolean notificationOutstanding;
    private PluginCall pendingStartCall;
    private BroadcastReceiver screenOff;
    /** The live Activity's plugin, if any; the service only signals it, never waits on it. */
    private static OverlayPlugin active;

    /** Main thread. The mark itself stays in OverlaySession for a later consumeRevocation. */
    static void notifyRevoked(String fingerprint) {
        OverlayPlugin plugin = active;
        if (plugin != null) plugin.notifyListeners("revoked", new JSObject().put("fingerprint", fingerprint));
    }

    @Override
    public void load() {
        active = this;
        screenOff = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                OverlaySession session = pending;
                if (session != null && session.state != OverlaySession.State.ACTIVE) {
                    session.stop("CANCELLED", "화면 잠금으로 시작을 취소했습니다.", null);
                }
            }
        };
        ContextCompat.registerReceiver(getContext(), screenOff,
            new IntentFilter(Intent.ACTION_SCREEN_OFF), ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @PluginMethod
    public void status(PluginCall call) {
        main.post(() -> {
            JSObject value = new JSObject();
            value.put("overlayAllowed", Settings.canDrawOverlays(getContext()));
            OverlaySession session = OverlaySession.current;
            boolean running = session != null && session.state == OverlaySession.State.ACTIVE;
            value.put("running", running);
            if (running) {
                value.put("sessionId", session.id);
                value.put("profileId", session.profileId);
                value.put("projectId", session.projectId);
                if (session.activeQuestionId != null) value.put("questionId", session.activeQuestionId);
            }
            call.resolve(value);
        });
    }

    @PluginMethod
    public void requestOverlayPermission(PluginCall call) {
        main.post(() -> {
            if (Settings.canDrawOverlays(getContext())) {
                call.resolve(new JSObject().put("granted", true));
                return;
            }
            if (permissionCall != null || consentOutstanding || pending != null) {
                call.reject("다른 권한 요청이 진행 중입니다.", "BUSY");
                return;
            }
            permissionCall = call;
            settingsLeft = false;
            try {
                startActivityForResult(call, new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getContext().getPackageName())), "overlayPermissionResult");
            } catch (RuntimeException error) {
                permissionCall = null;
                call.reject("다른 앱 위에 표시 설정을 열 수 없습니다.", "PERMISSION");
            }
        });
    }

    @ActivityCallback
    private void overlayPermissionResult(PluginCall call, ActivityResult result) {
        finishOverlayPermission();
    }

    private void finishOverlayPermission() {
        PluginCall call = permissionCall;
        permissionCall = null;
        settingsLeft = false;
        if (call != null) call.resolve(new JSObject().put("granted", Settings.canDrawOverlays(getContext())));
    }

    @PluginMethod
    public void start(PluginCall call) {
        main.post(() -> begin(call));
    }

    private void begin(PluginCall call) {
        OverlaySession candidate;
        try {
            JSObject pairing = call.getObject("pairing");
            String profile = required(call.getString("profileId"));
            String project = required(call.getString("projectId"));
            String question = call.getString("questionId");
            if (question != null) required(question);
            if (pairing == null) throw new IllegalArgumentException();
            JSONArray array = pairing.getJSONArray("addresses");
            if (array.length() == 0) throw new IllegalArgumentException();
            String[] addresses = new String[array.length()];
            for (int i = 0; i < array.length(); i++) addresses[i] = required(array.getString(i));
            int port = pairing.getInt("port");
            if (port < 1 || port > 65535) throw new IllegalArgumentException();
            candidate = new OverlaySession(addresses, port, required(pairing.getString("fingerprint")),
                required(pairing.getString("token")), profile, project, question);
        } catch (Exception error) {
            call.reject("연결 및 프로젝트 정보를 확인해 주세요.", "INVALID_CONTEXT");
            return;
        }
        OverlaySession.StartResult result = new OverlaySession.StartResult() {
            @Override public void active(String id) {
                if (pending != null && pending.id.equals(id)) {
                    pending = null;
                    pendingStartCall = null;
                }
                call.resolve(new JSObject().put("sessionId", id));
            }
            @Override public void failed(String code, String message) {
                if (pending == candidate || pending == OverlaySession.current) {
                    pending = null;
                    pendingStartCall = null;
                }
                call.reject(message, code);
            }
        };
        OverlaySession existing = OverlaySession.current;
        if (existing != null) {
            if (existing.state == OverlaySession.State.STOPPING || !existing.sameContext(candidate)) {
                call.reject("화면 질문 세션을 먼저 종료해 주세요.", "BUSY");
            } else existing.addStart(result);
            return;
        }
        if (permissionCall != null || consentOutstanding || notificationOutstanding || pending != null) {
            call.reject("권한 요청이 끝난 뒤 다시 시작해 주세요.", "BUSY");
            return;
        }
        if (!Settings.canDrawOverlays(getContext())) {
            call.reject("다른 앱 위에 표시 권한을 허용한 뒤 다시 시작해 주세요.", "OVERLAY_PERMISSION");
            return;
        }
        if (!getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED) || locked()) {
            call.reject("잠금을 해제하고 앱에서 다시 시작해 주세요.", "CANCELLED");
            return;
        }
        OverlaySession.current = candidate;
        candidate.awaitConsent();
        candidate.addStart(result);
        pending = candidate;
        pendingStartCall = call;
        pendingEpoch = candidate.epoch;
        try {
            if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getContext(),
                Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                notificationOutstanding = true;
                requestPermissionForAlias("notifications", call, "notificationResult");
            } else requestProjection(call);
        } catch (RuntimeException error) {
            notificationOutstanding = false;
            candidate.stop("START_FAILED", "화면 공유를 시작할 수 없습니다.", null);
        }
    }

    private static String required(String value) {
        if (value == null || value.trim().isEmpty()) throw new IllegalArgumentException();
        return value;
    }

    private boolean locked() {
        KeyguardManager manager = (KeyguardManager) getContext().getSystemService(Context.KEYGUARD_SERVICE);
        return manager == null || manager.isKeyguardLocked();
    }

    @PermissionCallback
    private void notificationResult(PluginCall call) {
        // Notification denial does not forbid a user-initiated media-projection FGS.
        notificationOutstanding = false;
        if (call != null && call == pendingStartCall) requestProjection(call);
    }

    private void requestProjection(PluginCall call) {
        OverlaySession session = pending;
        if (session == null || !session.isCurrent(pendingEpoch)) return;
        if (locked() || getActivity().isFinishing() || getActivity().isDestroyed()) {
            session.stop("CANCELLED", "화면 공유 시작을 취소했습니다.", null);
            return;
        }
        try {
            MediaProjectionManager manager = (MediaProjectionManager)
                getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            Intent intent = Build.VERSION.SDK_INT >= 34
                ? manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
                : manager.createScreenCaptureIntent();
            consentOutstanding = true;
            startActivityForResult(call, intent, "projectionResult");
        } catch (RuntimeException error) {
            consentOutstanding = false;
            session.stop("START_FAILED", "시스템 화면 공유 동의를 열 수 없습니다.", null);
        }
    }

    @ActivityCallback
    private void projectionResult(PluginCall call, ActivityResult result) {
        consentOutstanding = false;
        OverlaySession session = pending;
        if (session == null || !session.isCurrent(pendingEpoch)) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || locked()
            || getActivity().isFinishing() || getActivity().isDestroyed()) {
            session.stop("CANCELLED", "화면 공유 시작을 취소했습니다.", null);
            return;
        }
        if (!Settings.canDrawOverlays(getContext())) {
            session.stop("OVERLAY_PERMISSION", "다른 앱 위에 표시 권한이 필요합니다.", null);
            return;
        }
        if (!session.beginStarting(pendingEpoch)) return;
        session.consent = result.getData();
        session.consentResult = result.getResultCode();
        try {
            final long epoch = session.epoch;
            // Only this process-local ID crosses the service boundary, never pairing or consent.
            getContext().startForegroundService(new Intent(getContext(), OverlaySessionService.class)
                .putExtra(OverlaySessionService.SESSION_ID, session.id));
            main.postDelayed(() -> {
                if (session.isCurrent(epoch) && session.state == OverlaySession.State.STARTING) {
                    session.stop("START_FAILED", "화면 공유 초기화 시간이 초과되었습니다.", null);
                }
            }, 15000);
        } catch (RuntimeException error) {
            session.stop("START_FAILED", "화면 공유 서비스를 시작할 수 없습니다.", null);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            OverlaySession session = OverlaySession.current;
            if (session == null) call.resolve();
            else session.stop("CANCELLED", "화면 질문 시작을 취소했습니다.", () -> call.resolve());
        });
    }

    @PluginMethod
    public void consumeRevocation(PluginCall call) {
        main.post(() -> {
            String fingerprint = OverlaySession.revokedFingerprint;
            OverlaySession.revokedFingerprint = null;
            if (fingerprint == null) call.resolve(null);
            else call.resolve(new JSObject().put("fingerprint", fingerprint));
        });
    }

    // Capacitor's default implementation serializes the complete PluginCall, including pairing.
    @Override protected Bundle saveInstanceState() { return null; }

    @Override protected void handleOnPause() {
        if (permissionCall != null) settingsLeft = true;
    }

    @Override protected void handleOnResume() {
        if (permissionCall != null && settingsLeft) finishOverlayPermission();
    }

    @Override protected void handleOnDestroy() {
        if (active == this) active = null;
        OverlaySession session = pending;
        pending = null;
        pendingStartCall = null;
        if (session != null && session.state != OverlaySession.State.ACTIVE) {
            session.stop("CANCELLED", "앱이 닫혀 화면 질문 시작을 취소했습니다.", null);
        }
        PluginCall call = permissionCall;
        permissionCall = null;
        if (call != null) call.reject("권한 요청을 취소했습니다.", "CANCELLED");
        if (screenOff != null) {
            getContext().unregisterReceiver(screenOff);
            screenOff = null;
        }
    }
}
