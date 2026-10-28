package io.github.kyungminseo1.fask;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.graphics.Insets;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.view.Choreographer;
import android.os.Looper;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
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
    }

    private static final String GEOMETRY_CHANGED = "화면 구성이 바뀌었습니다. 영역을 다시 선택해 주세요.";
    private final Context context;
    private final WindowManager windows;
    private final Listener listener;
    private final OverlayInkView ink;
    private final ImageView toggle;
    private final ScrollView toolbar;
    private final LinearLayout tools;
    private final FrameLayout panel;
    private final FrameLayout panelContent;
    private final WindowManager.LayoutParams toggleParams;
    private final WindowManager.LayoutParams toolbarParams;
    private final WindowManager.LayoutParams panelParams;
    private final WindowManager.LayoutParams inkParams;
    private final SharedPreferences position;
    private final List<Button> editButtons = new ArrayList<>();
    private final Switch finger;
    private final Button question;
    private final TextView notice;
    private final Rect bounds = new Rect();
    private final Rect safe = new Rect();
    private OverlayGeometry.GeometrySnapshot geometry;
    private int densityDpi;
    private int rotation;
    private long readerGeneration;
    private boolean closed;
    private boolean toolbarVisible;
    private boolean toolbarPinned;
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
        final boolean toggle;
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
        position = context.getSharedPreferences("overlay_position", Context.MODE_PRIVATE);
        ink = new OverlayInkView(context, this);
        inkParams = params(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, true, "FASK 편집");
        inkParams.flags |= WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN;
        if (Build.VERSION.SDK_INT >= 28) inkParams.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        if (Build.VERSION.SDK_INT >= 30) inkParams.setFitInsetsTypes(0);
        geometry = OverlayGeometry.snapshotAfter(null, 0, rotation, pixelBounds(),
            new OverlayGeometry.PointPx(bounds.left, bounds.top), new OverlayGeometry.SizePx(bounds.width(), bounds.height()), densityDpi, readerGeneration);
        ink.setGeometry(geometry);

        toggle = new ImageView(context);
        toggle.setImageResource(R.mipmap.ic_launcher);
        toggle.setScaleType(ImageView.ScaleType.FIT_CENTER);
        toggle.setContentDescription("FASK 화면 질문 메뉴");
        toggle.setElevation(dp(4));
        toggleParams = params(dp(48), dp(48), false, "FASK 토글");
        toggleParams.x = Math.round(position.getFloat("x", .92f) * Math.max(0, bounds.width() - dp(48)));
        toggleParams.y = Math.round(position.getFloat("y", .25f) * Math.max(0, bounds.height() - dp(48)));
        toggle.setOnClickListener(view -> toggleToolbar());
        installDrag(toggle, toggleParams, false, true);
        toggle.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
            if (!closed && toggle.isAttachedToWindow() && toggle.getWidth() > 0) listener.onToggleReady();
        });

        tools = new LinearLayout(context);
        tools.setOrientation(LinearLayout.VERTICAL);
        tools.setPadding(dp(8), dp(8), dp(8), dp(8));
        tools.setBackgroundColor(0xfff8fafc);
        toolbar = new ScrollView(context);
        toolbar.setFillViewport(false);
        toolbar.addView(tools);
        toolbarParams = params(dp(300), dp(350), false, "FASK 도구");
        toolbarParams.flags |= WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH;
        toolbar.setOnTouchListener((v, e) -> {
            if (e.getActionMasked() == MotionEvent.ACTION_OUTSIDE && !insideToggle(e)) perform(this::closePeek);
            return false;
        });
        addRow(new String[]{"읽기", "펜", "지우개"}, new Runnable[]{() -> setMode(Mode.IDLE), () -> setMode(Mode.PEN), () -> setMode(Mode.ERASER)}, false);
        // Reading and folding remain available while a request owns the edit lock.
        LinearLayout firstRow = (LinearLayout) tools.getChildAt(0);
        editButtons.add((Button) firstRow.getChildAt(1));
        editButtons.add((Button) firstRow.getChildAt(2));
        SharedPreferences penPrefs = context.getSharedPreferences("overlay_pen", Context.MODE_PRIVATE);
        int savedColor = penPrefs.getInt("color", OverlayInkView.PEN_COLORS[0]);
        int initialColor = OverlayInkView.PEN_COLORS[0];
        for (int c : OverlayInkView.PEN_COLORS) if (c == savedColor) initialColor = c;
        ink.setPenColor(initialColor);
        LinearLayout colorRow = new LinearLayout(context);
        List<View> swatches = new ArrayList<>();
        int[] selectedColor = {initialColor};
        Runnable styleSwatches = () -> {
            for (int i = 0; i < swatches.size(); i++) {
                int c = OverlayInkView.PEN_COLORS[i];
                GradientDrawable shape = new GradientDrawable();
                shape.setShape(GradientDrawable.OVAL);
                shape.setColor(c);
                if (c == selectedColor[0]) shape.setStroke(dp(3), 0xff5b51df); else shape.setStroke(dp(1), 0xffcbd5e1);
                swatches.get(i).setBackground(shape);
                swatches.get(i).setSelected(c == selectedColor[0]);
            }
        };
        for (int i = 0; i < OverlayInkView.PEN_COLORS.length; i++) {
            int c = OverlayInkView.PEN_COLORS[i];
            View swatch = new View(context);
            swatch.setContentDescription("펜 색상 " + (i + 1));
            swatch.setOnClickListener(v -> perform(() -> {
                selectedColor[0] = c;
                ink.setPenColor(c);
                styleSwatches.run();
                penPrefs.edit().putInt("color", c).apply();
            }));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(36), 1);
            lp.setMargins(dp(3), dp(3), dp(3), dp(3));
            colorRow.addView(swatch, lp);
            swatches.add(swatch);
        }
        styleSwatches.run();
        tools.addView(colorRow);
        addRow(new String[]{"모두 지우기", "영역 선택"}, new Runnable[]{ink::clearInk, () -> setMode(Mode.REGION)}, true);
        finger = new Switch(context);
        finger.setText("손가락으로 그리기");
        finger.setTextColor(0xff0f172a);
        finger.setMinHeight(dp(48));
        finger.setOnCheckedChangeListener((button, checked) -> ink.setFingerDrawing(checked));
        tools.addView(finger);
        notice = new TextView(context);
        notice.setText("필기는 화면 위치에 고정됩니다. 문서를 이동했다면 필기와 영역을 다시 설정하세요.\n보호된 화면은 검게 캡처되거나 캡처할 수 없습니다.");
        notice.setTextColor(0xff334155);
        notice.setTextSize(12);
        notice.setPadding(dp(4), dp(4), dp(4), dp(4));
        tools.addView(notice);
        LinearLayout actions = new LinearLayout(context);
        question = button("질문 · 앱 열기", this::showPanel);
        actions.addView(question, new LinearLayout.LayoutParams(0, dp(52), 1));
        actions.addView(button("종료", listener::onStop), new LinearLayout.LayoutParams(0, dp(52), 1));
        tools.addView(button("프로젝트 바꾸기", this::showProjectPicker), new LinearLayout.LayoutParams(-1, dp(48)));
        tools.addView(actions);

        panel = new FrameLayout(context);
        panel.setBackgroundColor(Color.WHITE);
        LinearLayout panelColumn = new LinearLayout(context);
        panelColumn.setOrientation(LinearLayout.VERTICAL);
        LinearLayout header = new LinearLayout(context);
        TextView title = new TextView(context);
        title.setText("FASK 화면 질문 · 이동");
        title.setTextColor(0xff0f172a);
        title.setGravity(Gravity.CENTER_VERTICAL);
        title.setPadding(dp(12), 0, 0, 0);
        header.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));
        header.addView(button("접기", this::hidePanel), new LinearLayout.LayoutParams(dp(80), dp(48)));
        panelColumn.addView(header);
        panelContent = new FrameLayout(context);
        panelColumn.addView(panelContent, new LinearLayout.LayoutParams(-1, 0, 1));
        TextView resize = new TextView(context);
        resize.setText("↘ 크기 조절");
        resize.setTextColor(0xff475569);
        resize.setGravity(Gravity.RIGHT | Gravity.CENTER_VERTICAL);
        resize.setPadding(0, 0, dp(12), 0);
        resize.setContentDescription("질문 패널 크기 조절");
        panelColumn.addView(resize, new LinearLayout.LayoutParams(-1, dp(36)));
        panel.addView(panelColumn, new FrameLayout.LayoutParams(-1, -1));
        panelParams = params(dp(420), dp(640), true, "FASK 질문");
        panelParams.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
        panelParams.x = dp(12); panelParams.y = dp(12);
        installDrag(title, panelParams, false, false);
        installDrag(resize, panelParams, true, false);
        refreshSafeBounds();
        clampAll();
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
    private Button button(String title, Runnable action) {
        Button button = new Button(context);
        button.setText(title); button.setTextSize(12); button.setAllCaps(false); button.setMinWidth(0);
        button.setPadding(dp(2), 0, dp(2), 0);
        button.setOnClickListener(v -> { perform(action); closePeek(); });
        return button;
    }
    private void addRow(String[] titles, Runnable[] actions, boolean editing) {
        LinearLayout row = new LinearLayout(context);
        for (int i = 0; i < titles.length; i++) {
            Button button = button(titles[i], actions[i]);
            row.addView(button, new LinearLayout.LayoutParams(0, dp(50), 1));
            if (editing) editButtons.add(button);
        }
        tools.addView(row);
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
        if (!closed) attach(toggle, toggleParams);
    }
    public boolean isToggleReady() { return toggle.isAttachedToWindow() && toggle.getWidth() > 0 && toggle.getHeight() > 0; }
    public Mode getMode() { return mode; }
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
        CaptureVisibility state = new CaptureVisibility(captureId, mode, toggle.isAttachedToWindow(),
            toolbar.isAttachedToWindow(), panel.isAttachedToWindow(), observer);
        captureVisibility = state;
        setCaptureLocked(true);
        WindowManager.LayoutParams observation = params(1, WindowManager.LayoutParams.MATCH_PARENT, false, "FASK 캡처 전환");
        observation.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE | WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM;
        observation.alpha = 0;
        observation.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
        attach(observer, observation);
        hideIme();
        panelParams.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        remove(ink); remove(toolbar); remove(panel); remove(toggle);
        mode = Mode.CAPTURING;
        ink.setMode(mode);
        state.observation = new Runnable() {
            @Override public void run() {
                if (closed || captureVisibility != state) return;
                boolean detached = !ink.isAttachedToWindow() && !toolbar.isAttachedToWindow()
                    && !panel.isAttachedToWindow() && !toggle.isAttachedToWindow();
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
        toolbarVisible = state.toolbar;
        if (state.toolbar) attach(toolbar, toolbarParams);
        if (state.toggle) attach(toggle, toggleParams);
        listener.onStateChanged();
    }

    public void setPanelContent(View content) {
        checkThread();
        if (closed) throw new IllegalStateException("Overlay closed");
        panelContent.removeAllViews();
        if (content != null) panelContent.addView(content, new FrameLayout.LayoutParams(-1, -1));
        hasPanelContent = content != null;
        question.setText(hasPanelContent ? "질문" : "질문 · 앱 열기");
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
        for (Button button : editButtons) button.setEnabled(!locked && geometryReady);
        finger.setEnabled(!locked);
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
            remove(toolbar); remove(toggle);
            if (toolbarVisible) attach(toolbar, toolbarParams);
            attach(toggle, toggleParams);
            ink.post(ink::reportGeometry);
        } else remove(ink);
        listener.onStateChanged();
    }

    public void showPanel() {
        checkThread();
        if (closed || captureLocked) return;
        if (!hasPanelContent) {
            setMode(Mode.IDLE);
            toolbarVisible = false; toolbarPinned = false; remove(toolbar);
            listener.onOpenApp();
            return;
        }
        mode = Mode.PANEL;
        ink.setMode(mode); remove(ink);
        toolbarVisible = false; toolbarPinned = false; remove(toolbar);
        panelParams.flags &= ~WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        clampAll(); attach(panel, panelParams); update(panel, panelParams);
        listener.onStateChanged();
    }
    /** Opens the panel with its project list expanded; no signal when showPanel opened the app instead. */
    private void showProjectPicker() {
        showPanel();
        if (mode == Mode.PANEL) listener.onProjectPicker();
    }
    private void hidePanelWindow() {
        hideIme();
        panelParams.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        update(panel, panelParams);
        remove(panel);
    }
    public void hidePanel() {
        checkThread();
        if (closed) return;
        if (captureVisibility != null) {
            captureVisibility.panel = false;
            if (captureVisibility.mode == Mode.PANEL) captureVisibility.mode = Mode.IDLE;
        }
        hidePanelWindow();
        if (mode == Mode.PANEL) mode = Mode.IDLE;
        listener.onStateChanged();
    }
    private void hideIme() {
        InputMethodManager ime = (InputMethodManager) context.getSystemService(Context.INPUT_METHOD_SERVICE);
        if (ime != null) {
            if (panel.getWindowToken() != null) ime.hideSoftInputFromWindow(panel.getWindowToken(), 0);
            if (ink.getWindowToken() != null) ime.hideSoftInputFromWindow(ink.getWindowToken(), 0);
        }
        panel.clearFocus();
    }
    /** Collapsed → peek (auto-closes) → pinned → collapsed. */
    private void toggleToolbar() {
        if (closed || captureLocked) return;
        if (!toolbarVisible) {
            toolbarVisible = true; toolbarPinned = false;
            positionToolbar(); attach(toolbar, toolbarParams); animatePeek();
        } else if (!toolbarPinned) toolbarPinned = true;
        else { toolbarVisible = false; toolbarPinned = false; remove(toolbar); }
    }
    private void closePeek() {
        if (toolbarVisible && !toolbarPinned) { toolbarVisible = false; remove(toolbar); }
    }
    private boolean insideToggle(MotionEvent e) {
        float x = e.getRawX(), y = e.getRawY();
        return x >= toggleParams.x && x < toggleParams.x + toggleParams.width
            && y >= toggleParams.y && y < toggleParams.y + toggleParams.height;
    }
    private void animatePeek() {
        boolean up = toolbarParams.y < toggleParams.y;
        tools.setAlpha(0f);
        tools.setTranslationY(up ? dp(24) : -dp(24));
        tools.animate().alpha(1f).translationY(0f).setDuration(160).start();
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
        notice.setText(GEOMETRY_CHANGED + "\n필기는 화면 위치에 고정됩니다. 문서를 이동했다면 필기와 영역을 다시 설정하세요.\n보호된 화면은 검게 캡처되거나 캡처할 수 없습니다.");
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
                }
            } else installGeometry(measured);
        });
    }
    @Override public void onRevisionChanged() { listener.onStateChanged(); }
    @Override public void onRegionConfirmed() { perform(this::showPanel); }
    @Override public void onRegionCancelled() { perform(() -> setMode(Mode.IDLE)); }

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
    private void positionToolbar() {
        toolbarParams.width = Math.min(dp(300), safe.width());
        toolbarParams.height = Math.min(dp(350), safe.height());
        toolbarParams.x = toggleParams.x;
        boolean up = toggleParams.y + toggleParams.height / 2 > safe.centerY();
        toolbarParams.y = up ? toggleParams.y - toolbarParams.height - dp(8) : toggleParams.y + toggleParams.height + dp(8);
        clamp(toolbarParams);
        // A narrow/short display can have no vertical space. Keep the toggle beside tools instead.
        if (overlaps(toggleParams, toolbarParams)) {
            toolbarParams.x = toggleParams.x >= safe.centerX() ? toggleParams.x - toolbarParams.width - dp(8) : toggleParams.x + toggleParams.width + dp(8);
            clamp(toolbarParams);
            if (overlaps(toggleParams, toolbarParams)) {
                toolbarParams.width = Math.max(1, safe.width() - toggleParams.width - dp(8));
                toolbarParams.x = toggleParams.x >= safe.centerX() ? safe.left : safe.right - toolbarParams.width;
                clamp(toolbarParams);
            }
        }
    }
    private boolean overlaps(WindowManager.LayoutParams a, WindowManager.LayoutParams b) {
        return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    }
    private void separateToggleAndPanel() {
        if (!overlaps(toggleParams, panelParams)) return;
        int[] xs = {safe.right - toggleParams.width, safe.left};
        int[] ys = {safe.top, safe.bottom - toggleParams.height};
        for (int x : xs) for (int y : ys) {
            toggleParams.x = x; toggleParams.y = y;
            if (!overlaps(toggleParams, panelParams)) return;
        }
        // Preserve a reachable toggle gutter on very small displays.
        panelParams.width = Math.max(1, Math.min(panelParams.width, safe.width() - toggleParams.width - dp(8)));
        panelParams.x = safe.left;
        toggleParams.x = safe.right - toggleParams.width;
        toggleParams.y = safe.top;
    }
    private void clampAll() {
        toggleParams.width = Math.min(dp(48), safe.width()); toggleParams.height = Math.min(dp(48), safe.height());
        clamp(toggleParams);
        int maxWidth = Math.max(1, safe.width() - dp(24)), maxHeight = Math.max(1, safe.height() - dp(24));
        panelParams.width = Math.max(Math.min(dp(320), maxWidth), Math.min(panelParams.width, maxWidth));
        panelParams.height = Math.max(Math.min(dp(320), maxHeight), Math.min(panelParams.height, maxHeight));
        clamp(panelParams);
        if (mode == Mode.PANEL) separateToggleAndPanel();
        positionToolbar();
        update(toggle, toggleParams); update(toolbar, toolbarParams); update(panel, panelParams);
    }

    private void installDrag(View target, WindowManager.LayoutParams p, boolean resize, boolean saveToggle) {
        target.setOnTouchListener(new View.OnTouchListener() {
            float downX, downY;
            int startX, startY, startWidth, startHeight, pointer = -1;
            boolean moved;
            final int slop = ViewConfiguration.get(context).getScaledTouchSlop();
            @Override public boolean onTouch(View view, MotionEvent event) {
                if (closed || captureLocked) return true;
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        pointer = event.getPointerId(0); downX = event.getRawX(); downY = event.getRawY();
                        startX = p.x; startY = p.y; startWidth = p.width; startHeight = p.height; moved = false; return true;
                    case MotionEvent.ACTION_MOVE:
                        if (event.getPointerId(0) != pointer) return true;
                        float dx = event.getRawX() - downX, dy = event.getRawY() - downY;
                        if (dx * dx + dy * dy > slop * slop) moved = true;
                        if (moved) perform(() -> {
                            if (resize) { p.width = startWidth + Math.round(dx); p.height = startHeight + Math.round(dy); }
                            else { p.x = startX + Math.round(dx); p.y = startY + Math.round(dy); }
                            clampAll();
                        });
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (!moved) view.performClick();
                        else if (saveToggle) position.edit()
                            .putFloat("x", p.x / (float) Math.max(1, bounds.width() - p.width))
                            .putFloat("y", p.y / (float) Math.max(1, bounds.height() - p.height)).apply();
                        pointer = -1; return true;
                    case MotionEvent.ACTION_CANCEL: pointer = -1; return true;
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
        try { hideIme(); } catch (RuntimeException error) { first = error; }
        for (View view : new View[]{ink, toolbar, panel, toggle, capture == null ? null : capture.observer}) {
            if (view == null) continue;
            try { remove(view); } catch (RuntimeException error) { if (first == null) first = error; }
        }
        try { panelContent.removeAllViews(); } catch (RuntimeException error) { if (first == null) first = error; }
        if (first != null) throw first;
    }
}
