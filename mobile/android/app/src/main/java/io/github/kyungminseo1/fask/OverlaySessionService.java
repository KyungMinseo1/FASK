package io.github.kyungminseo1.fask;

import android.app.AppOpsManager;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Display;
import android.view.WindowManager;
import android.widget.Toast;
import androidx.core.content.ContextCompat;

/** Owns the complete live projection and native overlay, independently of the Activity. */
public final class OverlaySessionService extends Service {
    private OverlayWebBridge bridge;
    static final String SESSION_ID = "sessionId";
    private static final String STOP = "io.github.kyungminseo1.fask.OVERLAY_STOP";
    private static final String CHANNEL = "fask_screen_question";
    private static final int NOTIFICATION_ID = 2401;
    private final Handler main = new Handler(Looper.getMainLooper());
    private OverlaySession session;
    private long sessionEpoch;
    private int ownedStartId;
    private boolean releasing;
    private OverlayCaptureController capture;
    private DisplayManager displays;
    private Display display;
    private WindowManager windows;
    private Rect displayBounds;
    private int densityDpi;
    private int rotation;
    private OverlayWindowController overlay;
    private BroadcastReceiver screenOff;
    private AppOpsManager appOps;
    private AppOpsManager.OnOpChangedListener overlayPermission;
    private boolean displayListenerRegistered;

    private final Runnable safetyCheck = new Runnable() {
        @Override public void run() {
            if (!live()) return;
            if (locked()) stopSession("CLOSED", "화면 잠금으로 화면 질문을 종료했습니다.");
            else if (!Settings.canDrawOverlays(OverlaySessionService.this)) {
                stopSession("OVERLAY_PERMISSION", "다른 앱 위에 표시 권한이 해제되었습니다.");
            } else main.postDelayed(this, 1000);
        }
    };

    private final DisplayManager.DisplayListener displayListener = new DisplayManager.DisplayListener() {
        @Override public void onDisplayAdded(int id) {}
        @Override public void onDisplayRemoved(int id) {
            if (id == Display.DEFAULT_DISPLAY) stopSession("CLOSED", "화면 공유가 종료되었습니다.");
        }
        @Override public void onDisplayChanged(int id) {
            if (id != Display.DEFAULT_DISPLAY || !live()) return;
            try {
                Rect oldBounds = displayBounds;
                int oldDensity = densityDpi;
                int oldRotation = rotation;
                readDisplayGeometry();
                if (!displayBounds.equals(oldBounds) || densityDpi != oldDensity || rotation != oldRotation) {
                    if (capture != null) capture.updateDisplay(displayBounds, densityDpi);
                    if (overlay != null) overlay.updateDisplay(displayBounds, densityDpi, rotation, capture.getReaderGeneration());
                }
            } catch (RuntimeException error) {
                stopSession("START_FAILED", "화면 구성이 바뀌어 화면 질문을 종료했습니다. 앱에서 다시 시작해 주세요.");
            }
        }
    };

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String id = intent == null ? null : intent.getStringExtra(SESSION_ID);
        if (session != null) ownedStartId = startId;
        if (intent == null && session != null) {
            stopSession("CLOSED", "화면 질문 서비스가 종료되었습니다.");
            return START_NOT_STICKY;
        }
        if (intent != null && STOP.equals(intent.getAction())) {
            if (session != null && session.id.equals(id)) stopSession("CLOSED", "화면 질문을 종료했습니다.");
            else if (session == null) stopSelfResult(startId);
            return START_NOT_STICKY;
        }
        OverlaySession candidate = OverlaySession.current;
        if (id == null || candidate == null || !candidate.id.equals(id)
            || candidate.state != OverlaySession.State.STARTING || candidate.consent == null) {
            if (session == null) stopSelfResult(startId);
            return START_NOT_STICKY;
        }
        if (session != null) return START_NOT_STICKY;
        releasing = false;
        session = candidate;
        sessionEpoch = candidate.epoch;
        ownedStartId = startId;
        candidate.stopResources = this::releaseResources;
        try {
            if (locked()) {
                stopSession("CANCELLED", "잠금을 해제하고 앱에서 다시 시작해 주세요.");
                return START_NOT_STICKY;
            }
            if (!Settings.canDrawOverlays(this)) {
                stopSession("OVERLAY_PERMISSION", "다른 앱 위에 표시 권한이 필요합니다.");
                return START_NOT_STICKY;
            }
            startProjectionForeground();
            displays = (DisplayManager) getSystemService(DISPLAY_SERVICE);
            display = displays.getDisplay(Display.DEFAULT_DISPLAY);
            if (display == null) throw new IllegalStateException("No default display");
            windows = (WindowManager) createDisplayContext(display).getSystemService(WINDOW_SERVICE);
            readDisplayGeometry();
            registerGuards();
            capture = new OverlayCaptureController(this, main, candidate.id, sessionEpoch,
                () -> live() && session.state == OverlaySession.State.ACTIVE && !locked(),
                new OverlayCaptureController.Listener() {
                    @Override public void onReadyChanged(boolean ready, long readerGeneration) {
                        if (!live()) return;
                        if (overlay != null) overlay.setGeometryReady(ready);
                        if (ready) maybeActivate();
                    }
                    @Override public void onCapturedContentResize(int width, int height, boolean changed) {
                        if (!live()) return;
                        displayListener.onDisplayChanged(Display.DEFAULT_DISPLAY);
                        if (changed && overlay != null) overlay.capturedContentChanged();
                    }
                    @Override public void onFailure(String code, String message) {
                        if (live()) stopSession(code, message);
                    }
                });
            candidate.captureRequest = this::captureSelectedRegion;
            Intent consent = candidate.consent;
            candidate.consent = null; // one-shot, consumed only after startForeground succeeds
            capture.start(candidate.consentResult, consent, displayBounds, densityDpi);
            main.post(safetyCheck);
        } catch (RuntimeException error) {
            stopSession("START_FAILED", "화면 공유 초기화에 실패했습니다. 앱에서 다시 시작해 주세요.");
        }
        return START_NOT_STICKY;
    }

    private boolean live() {
        return session != null && session.isCurrent(sessionEpoch) && !releasing;
    }

    private boolean locked() {
        KeyguardManager manager = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        return manager == null || manager.isKeyguardLocked();
    }

    private void startProjectionForeground() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "화면 질문", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0,
            new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, session.id.hashCode(),
            new Intent(this, OverlaySessionService.class).setAction(STOP).putExtra(SESSION_ID, session.id),
            PendingIntent.FLAG_CANCEL_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_overlay_notification)
            .setContentTitle("FASK 화면 질문 사용 중")
            .setContentText("토글 또는 알림에서 화면 공유를 종료할 수 있습니다.")
            .setContentIntent(open).setOngoing(true).setCategory(Notification.CATEGORY_SERVICE)
            .addAction(new Notification.Action.Builder(null, "앱 열기", open).build())
            .addAction(new Notification.Action.Builder(null, "종료", stop).build()).build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else startForeground(NOTIFICATION_ID, notification);
    }

    private void readDisplayGeometry() {
        if (Build.VERSION.SDK_INT >= 30) displayBounds = new Rect(windows.getMaximumWindowMetrics().getBounds());
        else {
            DisplayMetrics metrics = new DisplayMetrics();
            display.getRealMetrics(metrics);
            displayBounds = new Rect(0, 0, metrics.widthPixels, metrics.heightPixels);
        }
        DisplayMetrics metrics = new DisplayMetrics();
        display.getRealMetrics(metrics);
        densityDpi = metrics.densityDpi;
        rotation = display.getRotation();
        if (displayBounds.isEmpty() || densityDpi <= 0) throw new IllegalStateException("Invalid display geometry");
    }

    private void maybeActivate() {
        if (!live() || capture == null || !capture.isReady()) return;
        if (overlay != null) overlay.setGeometryReady(true);
        if (session.state != OverlaySession.State.STARTING) return;
        try {
            if (overlay == null) {
                overlay = new OverlayWindowController(this, windows, displayBounds, densityDpi, rotation, capture.getReaderGeneration(),
                    new OverlayWindowController.Listener() {
                        @Override public void onToggleReady() { maybeActivate(); }
                        @Override public void onStateChanged() { if (bridge != null) bridge.onOverlayChanged(); }
                        @Override public void onGeometryChanged(OverlayGeometry.GeometrySnapshot geometry) {
                            if (capture != null) capture.cancelCapture("GEOMETRY_CHANGED", OverlayCaptureController.GEOMETRY_MESSAGE);
                            Toast.makeText(OverlaySessionService.this,
                                "화면 구성이 바뀌었습니다. 영역을 다시 선택해 주세요.", Toast.LENGTH_LONG).show();
                        }
                        @Override public void onOpenApp() {
                            try {
                                startActivity(new Intent(OverlaySessionService.this, MainActivity.class)
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP));
                            } catch (RuntimeException error) {
                                Toast.makeText(OverlaySessionService.this, "앱을 열 수 없습니다.", Toast.LENGTH_SHORT).show();
                            }
                        }
                        @Override public void onStop() { stopSession("CLOSED", "화면 질문을 종료했습니다."); }
                        @Override public void onWindowFailure() { stopSession("OVERLAY_PERMISSION", "화면 질문 창을 표시할 수 없습니다."); }
                        @Override public void onProjectPicker() { if (bridge != null) bridge.openProjectPicker(); }
                        @Override public void onProjectSelected(String projectId) { if (bridge != null) bridge.selectProject(projectId); }
                    });
                overlay.setGeometryReady(true);
                overlay.show();
                if (!OverlayWebBridge.supported()) {
                    stopSession("WEBVIEW", OverlayWebBridge.UPDATE_WEBVIEW);
                    return;
                }
                bridge = new OverlayWebBridge(this, main, session, sessionEpoch, overlay, new OverlayWebBridge.Host() {
                    @Override public boolean live(long epoch) { return OverlaySessionService.this.live() && epoch == sessionEpoch; }
                    @Override public void stop(String code, String message) { stopSession(code, message); }
                    @Override public void capture(OverlayCaptureController.Callback callback) { captureSelectedRegion(callback); }
                }, false);
                overlay.setPanelContent(bridge.view());
            }
            // Window attachment/layout is required, not just the addView call.
            if (overlay.isToggleReady()) session.activate(sessionEpoch);
        } catch (RuntimeException error) {
            stopSession("OVERLAY_PERMISSION", "화면 위 토글을 표시할 수 없습니다.");
        }
    }

    /** Internal native entry; the panel bridge and in-process instrumentation share this path. */
    void captureSelectedRegion(OverlayCaptureController.Callback callback) {
        if (!live() || capture == null || overlay == null || session.state != OverlaySession.State.ACTIVE) {
            callback.onFailure("CLOSED", OverlayCaptureController.CLOSED_MESSAGE);
            return;
        }
        if (locked()) {
            stopSession("CLOSED", "화면 잠금으로 화면 질문을 종료했습니다.");
            callback.onFailure("CLOSED", OverlayCaptureController.CLOSED_MESSAGE);
            return;
        }
        capture.captureSelectedRegion(overlay, callback);
    }

    private void registerGuards() {
        displays.registerDisplayListener(displayListener, main);
        displayListenerRegistered = true;
        screenOff = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                stopSession("CLOSED", "화면 잠금으로 화면 질문을 종료했습니다.");
            }
        };
        ContextCompat.registerReceiver(this, screenOff, new IntentFilter(Intent.ACTION_SCREEN_OFF),
            ContextCompat.RECEIVER_NOT_EXPORTED);
        appOps = (AppOpsManager) getSystemService(APP_OPS_SERVICE);
        overlayPermission = (op, packageName) -> main.post(() -> {
            if (live() && !Settings.canDrawOverlays(this)) {
                stopSession("OVERLAY_PERMISSION", "다른 앱 위에 표시 권한이 해제되었습니다.");
            }
        });
        appOps.startWatchingMode(AppOpsManager.OPSTR_SYSTEM_ALERT_WINDOW, getPackageName(), overlayPermission);
    }


    private void stopSession(String code, String message) {
        OverlaySession owned = session;
        if (owned == null || owned.state == OverlaySession.State.STOPPING || owned.state == OverlaySession.State.STOPPED) return;
        boolean wasActive = owned.state == OverlaySession.State.ACTIVE;
        owned.stop(code, message, null);
        if (wasActive) Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }

    private static void release(Runnable action) {
        try { action.run(); }
        catch (RuntimeException error) { Log.w("FaskOverlay", "Overlay resource release failed"); }
    }

    private void releaseResources() {
        if (releasing) return;
        releasing = true;
        main.removeCallbacks(safetyCheck);
        OverlaySession owned = session;
        session = null;
        if (displayListenerRegistered) {
            displayListenerRegistered = false;
            release(() -> displays.unregisterDisplayListener(displayListener));
        }
        BroadcastReceiver receiver = screenOff;
        screenOff = null;
        if (receiver != null) release(() -> unregisterReceiver(receiver));
        AppOpsManager.OnOpChangedListener permission = overlayPermission;
        overlayPermission = null;
        if (permission != null) release(() -> appOps.stopWatchingMode(permission));
        // Transport and panel go first so no late hub callback can reach a half-released session.
        OverlayWebBridge panel = bridge;
        bridge = null;
        if (panel != null) release(panel::close);
        OverlayCaptureController images = capture;
        capture = null;
        Runnable finish = () -> {
            OverlayWindowController ui = overlay;
            overlay = null;
            if (ui != null) release(ui::close);
            release(() -> stopForeground(STOP_FOREGROUND_REMOVE));
            release(() -> stopSelfResult(ownedStartId));
            if (owned != null) owned.stopped();
        };
        if (images != null) images.close(finish);
        else finish.run();
    }

    @Override public void onDestroy() {
        if (session != null) session.stop("CLOSED", "화면 질문 서비스가 종료되었습니다.", null);
        else releaseResources();
        super.onDestroy();
    }
}
