package io.github.kyungminseo1.fask;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.graphics.Insets;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.RectF;
import android.os.Build;
import android.os.Handler;
import android.view.Choreographer;
import android.os.Looper;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.List;

/** Main-thread owner of all overlay windows. A detached ink view retains only session memory. */
public final class OverlayWindowController implements OverlayInkView.Listener {
    public enum Mode { IDLE, PEN, ERASER, REGION, PANEL, CAPTURING }
    public interface Listener {
        void onToggleReady();
        void onStateChanged();
        void onGeometryChanged(OverlayGeometry.GeometrySnapshot geometry);
        void onOpenApp();
        void onStop();
        void onWindowFailure();
        void onProjectPicker();
        void onProjectSelected(String projectId);
    }

    private static final String GEOMETRY_CHANGED = "화면 구성이 바뀌었습니다. 영역을 다시 선택해 주세요.";
    /** Last confirmed capture region as display fractions plus the rotation it was chosen in. */
    private static final String REGION_PREFS = "overlay_region";
    private final Context context;
    private final WindowManager windows;
    private final Listener listener;
    private final OverlayInkView ink;
    private final OverlayChrome chrome;
    private final FrameLayout panel;
    private final FrameLayout panelContent;
    private final WindowManager.LayoutParams panelParams;
    private final LinearLayout panelHeader, panelRow;
    private final TextView panelEyebrow, panelTitle, panelFold;
    private final View panelHeaderRule, panelEdgeBar;
    private final FrameLayout panelEdge;
    private final SharedPreferences regionPrefs;
    private boolean resizingPanel;
    private final WindowManager.LayoutParams inkParams;
    private final Rect bounds = new Rect();
    private final Rect safe = new Rect();
    private OverlayGeometry.GeometrySnapshot geometry;
    private int densityDpi;
    private int rotation;
    private long readerGeneration;
    private boolean closed;
    private boolean hasPanelContent;
    private boolean interactionLocked;
    private boolean captureLocked;
    private boolean geometryReady;
    private boolean hasMeasuredInkGeometry;
    private Mode mode = Mode.IDLE;
    private final Handler main = new Handler(Looper.getMainLooper());
    private CaptureVisibility captureVisibility;

    private static final class CaptureVisibility {
        final String id;
        Mode mode;
        boolean toggle;
        final boolean toolbar;
        boolean panel;
        final View observer;
        Runnable observation;
        CaptureVisibility(String id, Mode mode, boolean toggle, boolean toolbar, boolean panel, View observer) {
            this.id = id; this.mode = mode; this.toggle = toggle; this.toolbar = toolbar;
            this.panel = panel; this.observer = observer;
        }
    }

    public OverlayWindowController(Context context, WindowManager windows, Rect bounds, int densityDpi,
        int rotation, long readerGeneration, Listener listener) {
        checkThread();
        this.context = context;
        this.windows = windows;
        this.listener = listener;
        this.bounds.set(bounds);
        this.densityDpi = densityDpi;
        this.rotation = rotation;
        this.readerGeneration = readerGeneration;
        ink = new OverlayInkView(context, this);
        inkParams = params(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, true, "FASK 편집");
        inkParams.flags |= WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;
        if (Build.VERSION.SDK_INT >= 28) inkParams.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        if (Build.VERSION.SDK_INT >= 30) inkParams.setFitInsetsTypes(0);
        geometry = OverlayGeometry.snapshotAfter(null, 0, rotation, pixelBounds(),
            new OverlayGeometry.PointPx(bounds.left, bounds.top), new OverlayGeometry.SizePx(bounds.width(), bounds.height()), densityDpi, readerGeneration);
        ink.setGeometry(geometry);

        chrome = new OverlayChrome(context, windows, densityDpi, bounds, new OverlayChrome.Host() {
            @Override public void perform(Runnable action) { OverlayWindowController.this.perform(action); }
            @Override public void onHandleReady() { if (!closed) listener.onToggleReady(); }
            @Override public void onPen() { setMode(mode == Mode.PEN ? Mode.IDLE : Mode.PEN); }
            @Override public void onEraser() { setMode(mode == Mode.ERASER ? Mode.IDLE : Mode.ERASER); }
            @Override public void onClearInk() { ink.clearInk(); }
            @Override public void onQuestion() { showPanel(); }
            @Override public void onDashboard() { setMode(Mode.IDLE); listener.onOpenApp(); }
            @Override public void onRegion() { setMode(Mode.REGION); }
            @Override public void onProjectPicker() { showProjectPicker(); }
            @Override public void onProjectSelected(String projectId) { listener.onProjectSelected(projectId); }
            @Override public void onStop() { listener.onStop(); }
            @Override public void onPenColor(int color) { ink.setPenColor(color); }
            @Override public void onFingerDrawing(boolean enabled) { ink.setFingerDrawing(enabled); }
            @Override public void onThemeChanged() { if (closed) return; stylePanel(); listener.onStateChanged(); }
        });

        // Mirrors the desktop .overlay-panel: header (eyebrow, project, 접기 ×), content, side width grip.
        panel = new FrameLayout(context);
        panel.setClipToOutline(true);
        LinearLayout panelColumn = new LinearLayout(context);
        panelColumn.setOrientation(LinearLayout.VERTICAL);
        panelHeader = new LinearLayout(context);
        panelHeader.setGravity(Gravity.CENTER_VERTICAL);
        panelHeader.setPadding(dp(12), dp(10), dp(12), dp(10));
        LinearLayout heading = new LinearLayout(context);
        heading.setOrientation(LinearLayout.VERTICAL);
        panelEyebrow = new TextView(context);
        panelEyebrow.setText("ASK IN CONTEXT");
        panelEyebrow.setTextSize(11);
        panelEyebrow.setLetterSpacing(0.05f);
        panelEyebrow.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        heading.addView(panelEyebrow);
        panelTitle = new TextView(context);
        panelTitle.setText("화면 질문");
        panelTitle.setTextSize(13);
        panelTitle.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        panelTitle.setSingleLine(true);
        panelTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
        panelTitle.setPadding(0, dp(4), 0, 0);
        heading.addView(panelTitle);
        panelHeader.addView(heading, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        panelFold = new TextView(context);
        panelFold.setText("접기 ×");
        panelFold.setTextSize(12);
        panelFold.setGravity(Gravity.CENTER);
        panelFold.setPadding(dp(10), dp(6), dp(10), dp(6));
        panelFold.setContentDescription("질문 창 접기");
        panelFold.setOnClickListener(v -> perform(this::hidePanel));
        panelHeader.addView(panelFold, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        panelColumn.addView(panelHeader, new LinearLayout.LayoutParams(-1, LinearLayout.LayoutParams.WRAP_CONTENT));
        panelHeaderRule = new View(context);
        panelColumn.addView(panelHeaderRule, new LinearLayout.LayoutParams(-1, Math.max(1, dp(1) / 2)));
        panelContent = new FrameLayout(context);
        panelColumn.addView(panelContent, new LinearLayout.LayoutParams(-1, 0, 1));
        panelRow = new LinearLayout(context);
        panelRow.setOrientation(LinearLayout.HORIZONTAL);
        panelRow.addView(panelColumn, new LinearLayout.LayoutParams(0, -1, 1));
        // Width-only grip on the side away from the nearer screen edge (see placePanelEdge).
        panelEdge = new FrameLayout(context);
        panelEdge.setContentDescription("질문 창 너비 조절");
        panelEdgeBar = new View(context);
        panelEdge.addView(panelEdgeBar, new FrameLayout.LayoutParams(dp(4), dp(40), Gravity.CENTER));
        panelRow.addView(panelEdge, new LinearLayout.LayoutParams(dp(14), -1));
        // Near a screen edge the grip sits inside the system back-gesture zone; claim its
        // centre (Android caps exclusions at 200dp per edge) so drags reach the grip.
        if (Build.VERSION.SDK_INT >= 29) panelEdge.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
            int mid = (b - t) / 2, half = Math.min(dp(100), mid);
            v.setSystemGestureExclusionRects(java.util.Collections.singletonList(new Rect(0, mid - half, r - l, mid + half)));
        });
        panel.addView(panelRow, new FrameLayout.LayoutParams(-1, -1));
        panelParams = params(dp(420), dp(640), true, "FASK 질문");
        panelParams.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
        // Tapping the app behind the panel folds it, like clicking outside the desktop panel.
        panelParams.flags |= WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH;
        panel.setOnTouchListener((v, e) -> {
            if (e.getActionMasked() == MotionEvent.ACTION_OUTSIDE && mode == Mode.PANEL && !imeVisible()) perform(this::hidePanel);
            return false;
        });
        panelParams.x = dp(12); panelParams.y = dp(12);
        installDrag(panelHeader, panelParams, false);
        installDrag(panelEdge, panelParams, true);
        stylePanel();
        refreshSafeBounds();
        clampAll();
        applyLock();
        regionPrefs = context.getSharedPreferences(REGION_PREFS, Context.MODE_PRIVATE);
        restoreSavedRegion();
    }

    private static void checkThread() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Overlay windows require main thread");
    }
    private int dp(int value) { return Math.round(value * densityDpi / 160f); }
    private OverlayGeometry.PixelRect pixelBounds() { return new OverlayGeometry.PixelRect(bounds.left, bounds.top, bounds.right, bounds.bottom); }
    private WindowManager.LayoutParams params(int width, int height, boolean focusable, String title) {
        WindowManager.LayoutParams p = new WindowManager.LayoutParams(width, height,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                | (focusable ? 0 : WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE), PixelFormat.TRANSLUCENT);
        p.gravity = Gravity.TOP | Gravity.LEFT;
        p.setTitle(title);
        if (Build.VERSION.SDK_INT >= 28) p.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        if (Build.VERSION.SDK_INT >= 30) p.setFitInsetsTypes(0);
        return p;
    }
    private void render() {
        if (closed) return;
        boolean locked = interactionLocked || captureLocked;
        chrome.render(mode, !locked && geometryReady, locked, mode == Mode.PANEL);
    }
    /** Project list for the native picker, sent by the panel page whenever it changes. */
    public void setProjects(List<OverlayChrome.Project> projects, String currentId, String lockReason) {
        checkThread();
        if (closed) return;
        chrome.setProjects(projects, currentId, lockReason);
        for (OverlayChrome.Project p : projects) if (p.id.equals(currentId)) panelTitle.setText(p.name);
    }
    /** Same tokens as the native toolbar, so the panel follows the app theme on every open. */
    private void stylePanel() {
        OverlayChrome.Palette c = chrome.palette();
        GradientDrawable card = new GradientDrawable();
        card.setCornerRadius(dp(12));
        card.setColor(c.bar);
        card.setStroke(Math.max(1, dp(1)), c.hairlineStrong);
        panel.setBackground(card);
        panelEyebrow.setTextColor(c.inkSubtle);
        panelTitle.setTextColor(c.ink);
        GradientDrawable fold = new GradientDrawable();
        fold.setCornerRadius(dp(8));
        fold.setColor(c.bar);
        fold.setStroke(Math.max(1, dp(1)), c.hairlineStrong);
        panelFold.setBackground(fold);
        panelFold.setTextColor(c.inkSubtle);
        panelHeaderRule.setBackgroundColor(c.hairline);
        GradientDrawable grip = new GradientDrawable();
        grip.setCornerRadius(dp(2));
        grip.setColor(c.hairlineStrong);
        panelEdgeBar.setBackground(grip);
    }
    /** Keyboard taps reach the panel as outside touches; they must not fold it. */
    private boolean imeVisible() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsets insets = panel.getRootWindowInsets();
            return insets != null && insets.isVisible(WindowInsets.Type.ime());
        }
        Rect visible = new Rect();
        panel.getWindowVisibleDisplayFrame(visible);
        return visible.height() < bounds.height() * 3 / 4;
    }
    private void perform(Runnable action) {
        if (closed) return;
        checkThread();
        try { action.run(); } catch (RuntimeException error) { listener.onWindowFailure(); }
    }
    private void attach(View view, WindowManager.LayoutParams p) { if (!view.isAttachedToWindow()) windows.addView(view, p); }
    private void remove(View view) { if (view.isAttachedToWindow()) windows.removeViewImmediate(view); }
    private void update(View view, WindowManager.LayoutParams p) { if (view.isAttachedToWindow()) windows.updateViewLayout(view, p); }

    public void show() {
        checkThread();
        if (!closed) chrome.attachHandle();
    }
    public boolean isToggleReady() { return chrome.isHandleReady(); }
    public Mode getMode() { return mode; }
    public boolean isDarkTheme() { return chrome.isDark(); }
    public OverlayInkView getInk() { return ink; }
    public OverlayGeometry.GeometrySnapshot getGeometry() { return geometry; }
    public boolean isGeometryReady() { return geometryReady; }

    /**
     * Detach every visible FASK window, then observe the real IME insets on a transparent,
     * non-interactive one-pixel-wide window. Its own removal precedes the UI frame barrier.
     * This is not a SurfaceFlinger fence; cross-app capture must also be verified on-device.
     */
    public void hideForCapture(String captureId, Runnable hidden) {
        checkThread();
        if (closed || captureVisibility != null) throw new IllegalStateException("Capture already owns windows");
        View observer = new View(context);
        CaptureVisibility state = new CaptureVisibility(captureId, mode, chrome.isHandleAttached(),
            chrome.isBarShown(), panel.isAttachedToWindow(), observer);
        captureVisibility = state;
        setCaptureLocked(true);
        WindowManager.LayoutParams observation = params(1, WindowManager.LayoutParams.MATCH_PARENT, false, "FASK 캡처 전환");
        observation.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE | WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM;
        observation.alpha = 0;
        observation.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
        attach(observer, observation);
        hideIme();
        panelParams.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        remove(ink); chrome.detachAll(); remove(panel);
        mode = Mode.CAPTURING;
        ink.setMode(mode);
        state.observation = new Runnable() {
            @Override public void run() {
                if (closed || captureVisibility != state) return;
                boolean detached = !ink.isAttachedToWindow() && !chrome.anyAttached() && !panel.isAttachedToWindow();
                boolean imeHidden = false;
                if (observer.isAttachedToWindow() && observer.getWidth() > 0) {
                    if (Build.VERSION.SDK_INT >= 30) {
                        WindowInsets insets = observer.getRootWindowInsets();
                        imeHidden = insets != null && !insets.isVisible(WindowInsets.Type.ime());
                    } else {
                        Rect visible = new Rect();
                        observer.getWindowVisibleDisplayFrame(visible);
                        // Pre-30 has no IME visibility API. Require the actual visible bottom to
                        // reach the display's navigation-safe bottom, not a guessed keyboard size.
                        imeHidden = !visible.isEmpty() && visible.bottom >= bounds.top + safe.bottom;
                    }
                }
                if (!detached || !imeHidden) { main.postDelayed(this, 16); return; }
                try { remove(observer); }
                catch (RuntimeException error) { listener.onWindowFailure(); return; }
                Choreographer.getInstance().postFrameCallback(time -> {
                    if (!closed && captureVisibility == state && !observer.isAttachedToWindow()) hidden.run();
                });
            }
        };
        main.post(state.observation);
        listener.onStateChanged();
    }

    /** Only the owning capture can restore, and a fold requested while hidden stays folded. */
    public void restoreAfterCapture(String captureId, boolean restore) {
        checkThread();
        CaptureVisibility state = captureVisibility;
        if (state == null || !state.id.equals(captureId)) return;
        if (state.observation != null) main.removeCallbacks(state.observation);
        remove(state.observer);
        captureVisibility = null;
        setCaptureLocked(false);
        if (closed || !restore) return;
        mode = state.mode;
        if ((interactionLocked || !geometryReady) && (mode == Mode.PEN || mode == Mode.ERASER || mode == Mode.REGION)) mode = Mode.IDLE;
        ink.setMode(mode);
        if (mode == Mode.PEN || mode == Mode.ERASER || mode == Mode.REGION) attach(ink, inkParams);
        if (state.panel && mode == Mode.PANEL && hasPanelContent) {
            panelParams.flags &= ~WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
            attach(panel, panelParams);
            // Never force-show an IME the user may have dismissed during capture.
        }
        // A panel that was not brought back must not leave the handle hidden with it.
        chrome.restore(state.toggle || (state.panel && !panel.isAttachedToWindow()), state.toolbar);
        listener.onStateChanged();
        render();
    }

    public void setPanelContent(View content) {
        checkThread();
        if (closed) throw new IllegalStateException("Overlay closed");
        panelContent.removeAllViews();
        if (content != null) panelContent.addView(content, new FrameLayout.LayoutParams(-1, -1));
        hasPanelContent = content != null;
        if (!hasPanelContent) hidePanel();
    }

    public void setInteractionState(boolean busy, boolean running, boolean unresolved) {
        checkThread();
        interactionLocked = busy || running || unresolved;
        applyLock();
        if (interactionLocked && (mode == Mode.PEN || mode == Mode.ERASER || mode == Mode.REGION)) setMode(Mode.IDLE);
    }
    public boolean isInteractionLocked() { return interactionLocked; }
    private void applyLock() {
        boolean locked = interactionLocked || captureLocked;
        ink.setInteractionLocked(locked);
        render();
    }
    public void setCaptureLocked(boolean locked) {
        checkThread(); captureLocked = locked; applyLock();
    }

    public void setMode(Mode next) {
        checkThread();
        if (closed || captureLocked) return;
        boolean editing = next == Mode.PEN || next == Mode.ERASER || next == Mode.REGION;
        if (editing && (interactionLocked || !geometryReady)) return;
        if (next == Mode.PANEL) { showPanel(); return; }
        if (next == Mode.CAPTURING) throw new IllegalArgumentException("Capture owns visibility and mode");
        hidePanelWindow();
        mode = next;
        ink.setMode(next);
        if (editing) {
            attach(ink, inkParams);
            ink.requestFocus();
            // Tools must sit above the explicitly touch-owning full-display editor.
            chrome.raise();
            ink.post(ink::reportGeometry);
        } else remove(ink);
        listener.onStateChanged();
        render();
    }

    public void showPanel() {
        checkThread();
        if (closed || captureLocked) return;
        if (!hasPanelContent) {
            setMode(Mode.IDLE);
            chrome.collapse();
            listener.onOpenApp();
            render();
            return;
        }
        mode = Mode.PANEL;
        ink.setMode(mode); remove(ink);
        chrome.hideHandle();
        panelParams.flags &= ~WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        stylePanel();
        clampAll(); attach(panel, panelParams); update(panel, panelParams);
        listener.onStateChanged();
        render();
    }
    /** Opens the panel with its project list expanded; no signal when showPanel opened the app instead. */
    private void showProjectPicker() {
        showPanel();
        if (mode == Mode.PANEL) listener.onProjectPicker();
    }
    private void hidePanelWindow() {
        boolean shown = panel.isAttachedToWindow();
        hideIme();
        panelParams.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        update(panel, panelParams);
        remove(panel);
        // The handle steps aside while the panel is open; capture restores it itself.
        if (shown && captureVisibility == null) chrome.attachHandle();
    }
    public void hidePanel() {
        checkThread();
        if (closed) return;
        if (captureVisibility != null) {
            if (captureVisibility.panel) captureVisibility.toggle = true;
            captureVisibility.panel = false;
            if (captureVisibility.mode == Mode.PANEL) captureVisibility.mode = Mode.IDLE;
        }
        hidePanelWindow();
        if (mode == Mode.PANEL) mode = Mode.IDLE;
        listener.onStateChanged();
        render();
    }
    private void hideIme() {
        InputMethodManager ime = (InputMethodManager) context.getSystemService(Context.INPUT_METHOD_SERVICE);
        if (ime != null) {
            if (panel.getWindowToken() != null) ime.hideSoftInputFromWindow(panel.getWindowToken(), 0);
            if (ink.getWindowToken() != null) ime.hideSoftInputFromWindow(ink.getWindowToken(), 0);
        }
        panel.clearFocus();
    }
    public void updateDisplay(Rect nextBounds, int nextDensity, int nextRotation, long generation) {
        checkThread();
        if (closed) return;
        boolean changed = !bounds.equals(nextBounds) || densityDpi != nextDensity || rotation != nextRotation || readerGeneration != generation;
        bounds.set(nextBounds); densityDpi = nextDensity; rotation = nextRotation; readerGeneration = generation;
        if (changed) {
            geometryReady = false;
            installGeometry(OverlayGeometry.snapshotAfter(geometry, 0, rotation, pixelBounds(),
                geometry.inkOriginPx, geometry.inkSizePx, densityDpi, readerGeneration));
        }
        refreshSafeBounds(); clampAll();
        if (ink.isAttachedToWindow()) ink.post(ink::reportGeometry);
    }
    /** A matching fresh reader frame enables a new selection; old coordinates stay discarded. */
    public void setGeometryReady(boolean ready) {
        checkThread();
        if (geometryReady == ready) return;
        geometryReady = ready; applyLock();
    }
    public void capturedContentChanged() {
        checkThread();
        installGeometry(OverlayGeometry.invalidate(geometry));
    }
    private void installGeometry(OverlayGeometry.GeometrySnapshot next) {
        if (next == geometry) return;
        geometry = next;
        ink.setGeometry(next);
        ink.invalidateGeometry();
        restoreSavedRegion();
        Toast.makeText(context, GEOMETRY_CHANGED, Toast.LENGTH_SHORT).show();
        listener.onGeometryChanged(next);
        if (mode == Mode.PEN || mode == Mode.ERASER || mode == Mode.REGION) setMode(Mode.IDLE);
    }
    @Override public void onGeometryMeasured(int x, int y, int width, int height) {
        if (closed) return;
        perform(() -> {
            OverlayGeometry.GeometrySnapshot measured = OverlayGeometry.snapshotAfter(geometry, 0, rotation, pixelBounds(),
                new OverlayGeometry.PointPx(x, y), new OverlayGeometry.SizePx(width, height), densityDpi, readerGeneration);
            if (!hasMeasuredInkGeometry) {
                // The constructor bounds are provisional, not a previous measured editor layout.
                // Establish the first real origin without cancelling the user's requested edit mode.
                hasMeasuredInkGeometry = true;
                if (measured != geometry) {
                    geometry = measured;
                    ink.setGeometry(measured);
                    ink.invalidateGeometry();
                    restoreSavedRegion();
                }
            } else installGeometry(measured);
        });
    }
    @Override public void onRevisionChanged() { listener.onStateChanged(); }
    @Override public void onRegionConfirmed() { perform(this::showPanel); }
    @Override public void onRegionCancelled() { perform(() -> setMode(Mode.IDLE)); }
    @Override public void onRegionSaved(RectF r) {
        float w = Math.max(1, bounds.width()), h = Math.max(1, bounds.height());
        regionPrefs.edit().putFloat("l", r.left / w).putFloat("t", r.top / h)
            .putFloat("r", r.right / w).putFloat("b", r.bottom / h).putInt("rot", rotation).apply();
    }
    /** The last confirmed selection, rescaled to this display; a different rotation needs a new one. */
    private void restoreSavedRegion() {
        RectF saved = null;
        if (regionPrefs.contains("l") && regionPrefs.getInt("rot", -1) == rotation) {
            float w = bounds.width(), h = bounds.height();
            saved = new RectF(regionPrefs.getFloat("l", 0) * w, regionPrefs.getFloat("t", 0) * h,
                regionPrefs.getFloat("r", 0) * w, regionPrefs.getFloat("b", 0) * h);
            if (saved.width() <= 0 || saved.height() <= 0) saved = null;
        }
        if (saved == null && ink.getRegion() == null) return;
        ink.restoreRegion(saved);
    }

    private void refreshSafeBounds() {
        safe.set(0, 0, bounds.width(), bounds.height());
        if (Build.VERSION.SDK_INT >= 30) {
            Insets insets = windows.getMaximumWindowMetrics().getWindowInsets().getInsetsIgnoringVisibility(
                WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            safe.left += insets.left; safe.top += insets.top;
            safe.right -= insets.right; safe.bottom -= insets.bottom;
        } else {
            int status = context.getResources().getIdentifier("status_bar_height", "dimen", "android");
            int nav = context.getResources().getIdentifier("navigation_bar_height", "dimen", "android");
            if (status != 0) safe.top += context.getResources().getDimensionPixelSize(status);
            if (nav != 0) safe.bottom -= context.getResources().getDimensionPixelSize(nav);
        }
        ink.setToolBounds(safe);
    }
    private void clamp(WindowManager.LayoutParams p) {
        p.x = Math.max(safe.left, Math.min(p.x, safe.right - p.width));
        p.y = Math.max(safe.top, Math.min(p.y, safe.bottom - p.height));
    }
    private int clampPanelWidth(int width) {
        int max = Math.max(1, safe.width() - dp(24));
        return Math.max(Math.min(dp(320), max), Math.min(width, max));
    }
    private boolean dockedRight() { return panelParams.x + panelParams.width / 2 > safe.centerX(); }
    /** The width grip faces away from the nearer screen edge: left when docked right, else right. */
    private void placePanelEdge() {
        boolean atStart = panelRow.indexOfChild(panelEdge) == 0;
        boolean wantStart = dockedRight();
        if (atStart == wantStart) return;
        ViewGroup.LayoutParams lp = panelEdge.getLayoutParams();
        panelRow.removeView(panelEdge);
        panelRow.addView(panelEdge, wantStart ? 0 : panelRow.getChildCount(), lp);
    }
    private void clampAll() {
        chrome.setDisplay(densityDpi, bounds, safe);
        int maxHeight = Math.max(1, safe.height() - dp(24));
        panelParams.width = clampPanelWidth(panelParams.width);
        panelParams.height = Math.max(Math.min(dp(320), maxHeight), Math.min(panelParams.height, maxHeight));
        clamp(panelParams);
        // The grip under a resizing finger stays put until the gesture ends.
        if (mode == Mode.PANEL && !resizingPanel) placePanelEdge();
        update(panel, panelParams);
    }

    private void installDrag(View target, WindowManager.LayoutParams p, boolean resize) {
        target.setOnTouchListener(new View.OnTouchListener() {
            float downX, downY;
            int startX, startY, startWidth, pointer = -1;
            boolean moved, leftEdge;
            final int slop = ViewConfiguration.get(context).getScaledTouchSlop();
            @Override public boolean onTouch(View view, MotionEvent event) {
                int action = event.getActionMasked();
                if (resize && (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL)) resizingPanel = false;
                if (closed || captureLocked) return true;
                switch (action) {
                    case MotionEvent.ACTION_DOWN:
                        pointer = event.getPointerId(0); downX = event.getRawX(); downY = event.getRawY();
                        startX = p.x; startY = p.y; startWidth = p.width; moved = false;
                        leftEdge = dockedRight();
                        if (resize) resizingPanel = true;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        if (event.getPointerId(0) != pointer) return true;
                        float dx = event.getRawX() - downX, dy = event.getRawY() - downY;
                        if (dx * dx + dy * dy > slop * slop) moved = true;
                        if (moved) perform(() -> {
                            if (resize) {
                                p.width = clampPanelWidth(startWidth + (leftEdge ? -Math.round(dx) : Math.round(dx)));
                                if (leftEdge) p.x = startX + startWidth - p.width;
                            }
                            else { p.x = startX + Math.round(dx); p.y = startY + Math.round(dy); }
                            clampAll();
                        });
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (!moved) view.performClick();
                        pointer = -1;
                        if (resize) perform(OverlayWindowController.this::clampAll);
                        return true;
                    case MotionEvent.ACTION_CANCEL:
                        pointer = -1;
                        if (resize) perform(OverlayWindowController.this::clampAll);
                        return true;
                    default: return true;
                }
            }
        });
    }

    public void close() {
        checkThread();
        if (closed) return;
        closed = true;
        CaptureVisibility capture = captureVisibility;
        captureVisibility = null;
        if (capture != null && capture.observation != null) main.removeCallbacks(capture.observation);
        RuntimeException first = null;
        try { hideIme(); } catch (RuntimeException error) { if (first == null) first = error; }
        try { chrome.close(); } catch (RuntimeException error) { if (first == null) first = error; }
        for (View view : new View[]{ink, panel, capture == null ? null : capture.observer}) {
            if (view == null) continue;
            try { remove(view); } catch (RuntimeException error) { if (first == null) first = error; }
        }
        try { panelContent.removeAllViews(); } catch (RuntimeException error) { if (first == null) first = error; }
        if (first != null) throw first;
    }
}
