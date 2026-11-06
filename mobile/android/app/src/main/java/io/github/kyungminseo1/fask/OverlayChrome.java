package io.github.kyungminseo1.fask;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.ValueAnimator;
import android.content.ComponentCallbacks;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Outline;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.InsetDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Build;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.view.WindowManager;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.List;

/**
 * The floating handle, its toolbar and side popovers, styled after desktop personal.css
 * (.overlay-toolbar). Owns only these windows; mode, lock and capture rules stay in
 * {@link OverlayWindowController}. Main thread only.
 */
final class OverlayChrome {
    interface Host {
        void perform(Runnable action);
        void onHandleReady();
        void onPen();
        void onEraser();
        void onClearInk();
        void onQuestion();
        void onDashboard();
        void onRegion();
        /** No project list from the panel yet: fall back to the panel's own picker. */
        void onProjectPicker();
        void onProjectSelected(String projectId);
        void onStop();
        void onPenColor(int color);
        void onFingerDrawing(boolean enabled);
        /** The palette changed (app theme or system night mode). */
        void onThemeChanged();
        /** The app's UI language changed; native labels were already refreshed. */
        void onLanguageChanged();
    }

    static final class Project {
        final String id, name, group;
        Project(String id, String name, String group) { this.id = id; this.name = name; this.group = group; }
    }

    static final String THEME_PREFS = "overlay_theme";
    static final String THEME_KEY = "pref";
    /** Per-device answer-completed blink toggle, stored alongside the theme. Default on. */
    static final String BLINK_KEY = "answer_blink";
    private static final int R_MD = 8, R_LG = 12, R_TB = 14;
    private static final int HANDLE_W = 64, HANDLE_H = 58;
    /** Collapsed toggle: a 52dp tile centred in the 64x58 handle area (desktop .overlay-toolbar.collapsed). */
    private static final int TILE = 52;
    private static final int SHADOW = 10, ELEVATION = 6, GAP = 8;
    private static final int OPEN_MS = 180, CLOSE_MS = 130;
    private static final float COLLAPSED_ALPHA = .9f;

    private enum Attach { NONE, BELOW, ABOVE, LEFT, RIGHT }
    private enum Pop { NONE, PEN, PROJECT }

    /** personal.css theme tokens per app theme: surface set (panel, popovers) and the overlay toolbar set (--tb-*). */
    static final class Palette {
        /** The app theme key this mirrors (navy, white, ivory, lavender, night); also the panel's data-palette. */
        final String name;
        final int bar, hairline, hairlineStrong, ink, inkSubtle, primary, primarySoft;
        /** Toolbar fill, ink, selected fill/ink (--tb, --tb-ink, --tb-on, --tb-on-ink), 1dp --ring and --logo-acc. */
        final int tb, tbInk, tbOn, tbOnInk, ring, logo;
        Palette(String name, int bar, int hairline, int hairlineStrong, int ink, int inkSubtle, int primary,
                int primarySoft, int tb, int tbInk, int tbOn, int tbOnInk, int ring, int logo) {
            this.name = name;
            this.bar = bar; this.hairline = hairline; this.hairlineStrong = hairlineStrong; this.ink = ink;
            this.inkSubtle = inkSubtle; this.primary = primary; this.primarySoft = primarySoft;
            this.tb = tb; this.tbInk = tbInk; this.tbOn = tbOn; this.tbOnInk = tbOnInk; this.ring = ring; this.logo = logo;
        }
    }
    private static final Palette NAVY = new Palette("navy", 0xFFFBF7F0, 0xFFE6DDCB, 0xFFD0C4AE, 0xFF14213D, 0xFF535B6E,
        0xFF14213D, 0xFFEAE1D0, 0xFF14213D, 0xFFF4EDE0, 0xFFFF6B5B, 0xFF14213D, 0x33000000, 0xFFFF6B5B);
    private static final Palette WHITE = new Palette("white", 0xFFFFFFFF, 0xFFEAEAEA, 0xFFD6D6D4, 0xFF0B0B0C, 0xFF5F5F62,
        0xFF0B0B0C, 0xFFF2F2F2, 0xFFFFFFFF, 0xFF0B0B0C, 0xFF0B0B0C, 0xFFC6F432, 0x1F0B0B0C, 0xFFC6F432);
    private static final Palette IVORY = new Palette("ivory", 0xFFFBF8F1, 0xFFE2D6BE, 0xFFCBBC9E, 0xFF1A2A20, 0xFF5A6152,
        0xFF1F3D2B, 0xFFE8DCC4, 0xFF1F3D2B, 0xFFF3ECDD, 0xFFE8DCC4, 0xFF1F3D2B, 0x33000000, 0xFF6D3FD9);
    private static final Palette LAVENDER = new Palette("lavender", 0xFFF6F0FC, 0xFFD6C5EC, 0xFFBBA2DC, 0xFF2A1A40, 0xFF5E4D78,
        0xFF3B2160, 0xFFDCCAF0, 0xFFCBB3E8, 0xFF2A1A40, 0xFF3B2160, 0xFFE9FF9A, 0x332A1A40, 0xFFC6F432);
    private static final Palette NIGHT = new Palette("night", 0xFF141414, 0xFF232323, 0xFF3A3A3A, 0xFFF2F2EC, 0xFF9A9A92,
        0xFFD4FF3F, 0xFF1C1C1C, 0xFF0B0B0B, 0xFFF2F2EC, 0xFFD4FF3F, 0xFF0B0B0B, 0x26FFFFFF, 0xFFFF2DA8);

    private final Context context;
    private final WindowManager windows;
    private final Host host;
    private final SharedPreferences position, pen, theme, language;
    private final SharedPreferences.OnSharedPreferenceChangeListener themeListener, languageListener;
    private final ComponentCallbacks configListener;
    private int densityDpi;
    private Palette palette = NAVY;

    private final FrameLayout handleRoot, barRoot, popRoot;
    private final ToggleMarkView handle;
    private final FrameLayout barCard;
    private final LinearLayout popCard;
    private final ScrollView vScroll;
    private final HorizontalScrollView hScroll;
    private final LinearLayout tools;
    private final WindowManager.LayoutParams handleParams, barParams, popParams;
    private final LinearLayout penButton, eraser, clear, question, dashboard, region, project, stop;
    private final List<LinearLayout> buttons = new ArrayList<>();
    /** Korean label/description keys per toolbar button, parallel to {@link #buttons}. */
    private final List<String[]> buttonText = new ArrayList<>();
    private final List<View> dividers = new ArrayList<>();
    private final Rect bounds = new Rect();

    private final Rect safe = new Rect();
    private final Rect handleRect = new Rect();
    private final Rect barRect = new Rect();
    private final Rect popRect = new Rect();
    private Attach attach = Attach.NONE;
    private boolean horizontal, oriented;
    /** The popover a touch outside just closed, so that same trigger's click does not reopen it. */
    private Pop lastDismissed = Pop.NONE;
    private long lastDismissedAt;
    private boolean barShown, barVisual;
    private Pop pop = Pop.NONE;
    private View popAnchor;
    private ValueAnimator barAnimator;
    /** Pulses the handle's text alpha; the view alpha belongs to the touch/collapse logic. */
    private ValueAnimator attentionAnimator;

    private OverlayWindowController.Mode mode = OverlayWindowController.Mode.IDLE;
    private boolean editable = true, inputLocked, panelOpen;
    private int penColor;
    private boolean finger;
    private List<Project> projects;
    private String currentProject;
    private String projectLock;
    private boolean closed;

    OverlayChrome(Context context, WindowManager windows, int densityDpi, Rect bounds, Host host) {
        this.context = context;
        this.windows = windows;
        this.densityDpi = densityDpi;
        this.host = host;
        this.bounds.set(bounds);
        position = context.getSharedPreferences("overlay_position", Context.MODE_PRIVATE);
        pen = context.getSharedPreferences("overlay_pen", Context.MODE_PRIVATE);
        theme = context.getSharedPreferences(THEME_PREFS, Context.MODE_PRIVATE);
        language = Strings.prefs(context);

        handle = new ToggleMarkView(context, densityDpi / 160f);
        handle.setContentDescription(Strings.get(context, "FASK 화면 질문 메뉴"));
        handle.setOnClickListener(v -> host.perform(this::onHandleClick));
        handle.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
            if (!closed && handle.isAttachedToWindow() && handle.getWidth() > 0) host.onHandleReady();
        });
        installHandleDrag();
        handleRoot = root(handle);
        handleParams = params(Strings.get(context, "FASK 토글"), false);

        tools = new LinearLayout(context);
        int pad = dp(6);
        tools.setPadding(pad, pad, pad, pad);
        penButton = tool(ToolIconView.Kind.PEN, "펜", "펜", host::onPen);
        eraser = tool(ToolIconView.Kind.ERASER, "지우개", "지우개", host::onEraser);
        clear = tool(ToolIconView.Kind.CLEAR, "모두 지우기", "모두 지우기", host::onClearInk);
        divider();
        question = tool(ToolIconView.Kind.QUESTION, "질문", "질문, 앱 열기", () -> { host.onQuestion(); closePeek(); });
        dashboard = tool(ToolIconView.Kind.DASHBOARD, "대시보드", "대시보드", () -> { host.onDashboard(); closePeek(); });
        region = tool(ToolIconView.Kind.REGION, "캡처 영역", "캡처 영역 선택", () -> { host.onRegion(); closePeek(); });
        divider();
        project = tool(ToolIconView.Kind.PROJECT, "프로젝트", "프로젝트 바꾸기", this::onProjectButton);
        divider();
        stop = tool(ToolIconView.Kind.STOP, "종료", "FASK 화면 질문 종료", host::onStop);
        vScroll = new ScrollView(context);
        vScroll.setVerticalScrollBarEnabled(false);
        vScroll.setOverScrollMode(View.OVER_SCROLL_NEVER);
        hScroll = new HorizontalScrollView(context);
        hScroll.setHorizontalScrollBarEnabled(false);
        hScroll.setOverScrollMode(View.OVER_SCROLL_NEVER);
        barCard = new FrameLayout(context);
        barCard.setClipToOutline(true);
        barCard.addView(vScroll, new FrameLayout.LayoutParams(-1, -1));
        barCard.addView(hScroll, new FrameLayout.LayoutParams(-1, -1));
        vScroll.addView(tools);
        hScroll.setVisibility(View.GONE);
        barRoot = root(barCard);
        barParams = params(Strings.get(context, "FASK 도구"), true);
        barRoot.setOnTouchListener((v, e) -> {
            if (e.getActionMasked() == MotionEvent.ACTION_OUTSIDE && !inside(handleRect, e) && !(pop != Pop.NONE && inside(popRect, e))) {
                host.perform(this::closePeek);
            }
            return false;
        });

        popCard = new LinearLayout(context);
        popCard.setOrientation(LinearLayout.VERTICAL);
        popCard.setClipToOutline(true);
        popRoot = root(popCard);
        popParams = params(Strings.get(context, "FASK 선택"), true);
        // Any touch outside the popover (background, toolbar, other app) dismisses it.
        popRoot.setOnTouchListener((v, e) -> {
            if (e.getActionMasked() == MotionEvent.ACTION_OUTSIDE) host.perform(this::dismissPop);
            return false;
        });

        int saved = pen.getInt("color", OverlayInkView.PEN_COLORS[0]);
        penColor = OverlayInkView.PEN_COLORS[0];
        for (int c : OverlayInkView.PEN_COLORS) if (c == saved) penColor = c;
        // Phones rarely have a stylus; finger input starts on and is remembered.
        finger = pen.getBoolean("finger", true);
        host.onPenColor(penColor);
        host.onFingerDrawing(finger);

        int w = dp(HANDLE_W), h = dp(HANDLE_H);
        int x = Math.round(position.getFloat("x", .92f) * Math.max(0, bounds.width() - w));
        int y = Math.round(position.getFloat("y", .25f) * Math.max(0, bounds.height() - h));
        handleRect.set(x, y, x + w, y + h);

        themeListener = (prefs, key) -> {
            if (THEME_KEY.equals(key)) host.perform(this::applyTheme);
            else if (BLINK_KEY.equals(key) && !prefs.getBoolean(BLINK_KEY, true)) host.perform(() -> setAttention(false));
        };
        theme.registerOnSharedPreferenceChangeListener(themeListener);
        languageListener = (prefs, key) -> { if (Strings.KEY.equals(key)) host.perform(this::applyLanguage); };
        language.registerOnSharedPreferenceChangeListener(languageListener);
        configListener = new ComponentCallbacks() {
            @Override public void onConfigurationChanged(Configuration config) { host.perform(OverlayChrome.this::applyTheme); }
            @Override public void onLowMemory() {}
        };
        context.registerComponentCallbacks(configListener);
        palette = resolvePalette();
        restyle();
    }

    // ---------- public surface for the controller ----------

    void setDisplay(int densityDpi, Rect displayBounds, Rect safeBounds) {
        this.densityDpi = densityDpi;
        handle.setDensity(densityDpi / 160f);
        bounds.set(displayBounds);
        safe.set(safeBounds);
        int w = Math.min(dp(HANDLE_W), safe.width()), h = Math.min(dp(HANDLE_H), safe.height());
        handleRect.set(handleRect.left, handleRect.top, handleRect.left + w, handleRect.top + h);
        relayout();
    }

    Palette palette() { return palette; }
    boolean isDark() { return palette == NIGHT; }
    void moveHandle(int x, int y) {
        handleRect.offsetTo(x, y);
        relayout();
    }

    /** The bar window stays attached (invisible, untouchable) so opening animates without window-creation lag. */
    void attachHandle() {
        setBarVisual(barShown);
        attach(barRoot, barParams);
        attach(handleRoot, handleParams);
    }
    boolean isHandleAttached() { return added.contains(handleRoot); }
    boolean isHandleReady() { return handleRoot.isAttachedToWindow() && handle.getWidth() > 0 && handle.getHeight() > 0; }
    boolean isBarShown() { return barShown; }
    boolean anyAttached() { return added.contains(handleRoot) || added.contains(barRoot) || added.contains(popRoot); }

    private void setBarVisual(boolean visible) {
        barVisual = visible;
        barCard.setVisibility(visible ? View.VISIBLE : View.INVISIBLE);
        if (visible) barParams.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        else barParams.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        update(barRoot, barParams);
    }

    /** Capture: every chrome window leaves immediately, without animation. */
    void detachAll() {
        cancelBarAnimation();
        dismissPop();
        remove(barRoot);
        remove(handleRoot);
    }

    /** The question panel replaces the handle; its saved position stays untouched. */
    void hideHandle() {
        cancelBarAnimation();
        dismissPop();
        barShown = false;
        setBarVisual(false);
        relayout();
        restyle();
        remove(barRoot);
        remove(handleRoot);
    }

    void restore(boolean handleVisible, boolean barVisible) {
        barShown = barVisible;
        relayout();
        if (handleVisible) attachHandle();
        restyle();
    }

    /** Re-adds the visible chrome so it sits above a newly attached full-screen editor. */
    void raise() {
        boolean popOpen = added.contains(popRoot);
        remove(popRoot); remove(barRoot); remove(handleRoot);
        attachHandle();
        if (popOpen) attach(popRoot, popParams);
    }

    void collapse() {
        if (!barShown) return;
        barShown = false;
        dismissPop();
        animateBar(false);
    }

    void closePeek() {
        if (barShown) collapse();
    }

    void render(OverlayWindowController.Mode mode, boolean editable, boolean inputLocked, boolean panelOpen) {
        boolean enteredPen = mode == OverlayWindowController.Mode.PEN && this.mode != mode;
        this.mode = mode; this.editable = editable; this.inputLocked = inputLocked; this.panelOpen = panelOpen;
        if (pop == Pop.PEN && mode != OverlayWindowController.Mode.PEN) dismissPop();
        restyle();
        if (enteredPen && barShown) showPop(Pop.PEN, penButton);
        else if (pop != Pop.NONE) rebuildPop();
    }

    void setProjects(List<Project> list, String currentId, String lockReason) {
        projects = list;
        currentProject = currentId;
        projectLock = lockReason;
        if (pop == Pop.PROJECT) rebuildPop();
    }

    /** Blinks the "f" handle until cleared; ignored when this device turned the blink off. */
    void setAttention(boolean on) {
        if (closed) return;
        if (attentionAnimator != null) {
            attentionAnimator.cancel();
            attentionAnimator = null;
        }
        if (!on || !theme.getBoolean(BLINK_KEY, true)) {
            handle.setMarkAlpha(255);
            return;
        }
        ValueAnimator animator = ValueAnimator.ofInt(255, 64);
        animator.setDuration(600);
        animator.setRepeatMode(ValueAnimator.REVERSE);
        animator.setRepeatCount(ValueAnimator.INFINITE);
        animator.addUpdateListener(a -> handle.setMarkAlpha((int) a.getAnimatedValue()));
        attentionAnimator = animator;
        animator.start();
    }

    void close() {
        if (closed) return;
        closed = true;
        cancelBarAnimation();
        if (attentionAnimator != null) attentionAnimator.cancel();
        attentionAnimator = null;
        theme.unregisterOnSharedPreferenceChangeListener(themeListener);
        language.unregisterOnSharedPreferenceChangeListener(languageListener);
        context.unregisterComponentCallbacks(configListener);
        RuntimeException first = null;
        for (View view : new View[]{popRoot, barRoot, handleRoot}) {
            try { remove(view); } catch (RuntimeException error) { if (first == null) first = error; }
        }
        if (first != null) throw first;
    }

    // ---------- building blocks ----------

    private int dp(float value) { return Math.round(value * densityDpi / 160f); }

    private FrameLayout root(View card) {
        FrameLayout root = new FrameLayout(context);
        root.setClipChildren(false);
        root.setClipToPadding(false);
        root.addView(card, new FrameLayout.LayoutParams(-1, -1));
        return root;
    }

    private WindowManager.LayoutParams params(String title, boolean watchOutside) {
        WindowManager.LayoutParams p = new WindowManager.LayoutParams(1, 1,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | (watchOutside ? WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH : 0),
            PixelFormat.TRANSLUCENT);
        p.gravity = Gravity.TOP | Gravity.LEFT;
        p.setTitle(title);
        if (Build.VERSION.SDK_INT >= 28) p.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        if (Build.VERSION.SDK_INT >= 30) p.setFitInsetsTypes(0);
        return p;
    }

    private LinearLayout tool(ToolIconView.Kind kind, String label, String description, Runnable action) {
        LinearLayout button = new LinearLayout(context);
        button.setOrientation(LinearLayout.VERTICAL);
        button.setGravity(Gravity.CENTER);
        button.setPadding(0, dp(6), 0, dp(6));
        button.setClickable(true);
        ToolIconView g = new ToolIconView(context, kind, dp(20));
        TextView l = new TextView(context);
        l.setMaxLines(1);
        l.setGravity(Gravity.CENTER);
        l.setIncludeFontPadding(false);
        l.setLetterSpacing(-0.02f);
        if (Build.VERSION.SDK_INT >= 28) l.setTypeface(Typeface.create(Typeface.DEFAULT, 500, false));
        l.setPadding(0, dp(3), 0, 0);
        button.addView(g);
        button.addView(l);
        labelTool(button, label, description);
        button.setOnClickListener(v -> host.perform(action));
        tools.addView(button);
        buttons.add(button);
        buttonText.add(new String[]{label, description});
        return button;
    }

    private void labelTool(LinearLayout button, String label, String description) {
        button.setContentDescription(Strings.get(context, description));
        TextView l = (TextView) button.getChildAt(1);
        String text = Strings.get(context, label);
        l.setText(text);
        l.setTextSize(11);
        // Shrink long labels to the 64dp card's inner width instead of clipping.
        int inner = dp(HANDLE_W - 10);
        for (float sp = 11; sp > 8 && l.getPaint().measureText(text) > inner; sp -= .5f) l.setTextSize(sp - .5f);
    }

    private void divider() {
        View line = new View(context);
        tools.addView(line);
        dividers.add(line);
    }

    /** Vertical column (desktop) or a horizontal strip when the column cannot fit (landscape). */
    private void orient(boolean strip) {
        if (oriented && strip == horizontal) return;
        oriented = true;
        horizontal = strip;
        tools.setOrientation(strip ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        // The strip is only as tall as the 58dp handle, so it trims vertical padding.
        if (strip) tools.setPadding(dp(6), dp(3), dp(6), dp(3)); else tools.setPadding(dp(4), dp(6), dp(4), dp(6));
        for (LinearLayout b : buttons) {
            if (strip) b.setPadding(dp(2), dp(1), dp(2), dp(1)); else b.setPadding(0, dp(6), 0, dp(6));
        }
        for (int i = 0; i < tools.getChildCount(); i++) {
            View child = tools.getChildAt(i);
            LinearLayout.LayoutParams lp;
            if (dividers.contains(child)) {
                lp = strip ? new LinearLayout.LayoutParams(dp(1), -1) : new LinearLayout.LayoutParams(-1, dp(1));
                if (strip) lp.setMargins(dp(4), dp(6), dp(4), dp(6)); else lp.setMargins(dp(6), dp(4), dp(6), dp(4));
            } else {
                lp = strip ? new LinearLayout.LayoutParams(dp(52), -1) : new LinearLayout.LayoutParams(-1, -2);
                if (strip) lp.rightMargin = dp(2); else lp.bottomMargin = dp(2);
            }
            child.setLayoutParams(lp);
        }
        ViewGroup parent = (ViewGroup) tools.getParent();
        ViewGroup target = strip ? hScroll : vScroll;
        if (parent != target) {
            if (parent != null) parent.removeView(tools);
            target.addView(tools, strip ? new FrameLayout.LayoutParams(-2, -1) : new FrameLayout.LayoutParams(-1, -2));
        }
        vScroll.setVisibility(strip ? View.GONE : View.VISIBLE);
        hScroll.setVisibility(strip ? View.VISIBLE : View.GONE);
    }

    // ---------- geometry ----------

    private void clampHandle() {
        int w = handleRect.width(), h = handleRect.height();
        int x = Math.max(safe.left, Math.min(handleRect.left, safe.right - w));
        int y = Math.max(safe.top, Math.min(handleRect.top, safe.bottom - h));
        handleRect.offsetTo(x, y);
    }

    private void layoutBar() {
        int hw = handleRect.width(), hh = handleRect.height(), seam = dp(1);
        orient(false);
        tools.measure(View.MeasureSpec.makeMeasureSpec(hw, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        int column = tools.getMeasuredHeight();
        int above = handleRect.top - safe.top + seam, below = safe.bottom - handleRect.bottom + seam;
        boolean preferUp = handleRect.centerY() > safe.centerY();
        Attach vertical = null;
        if (column <= (preferUp ? above : below)) vertical = preferUp ? Attach.ABOVE : Attach.BELOW;
        else if (column <= (preferUp ? below : above)) vertical = preferUp ? Attach.BELOW : Attach.ABOVE;
        if (vertical == null) {
            orient(true);
            tools.measure(View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
                View.MeasureSpec.makeMeasureSpec(hh, View.MeasureSpec.EXACTLY));
            int strip = tools.getMeasuredWidth();
            int left = handleRect.left - safe.left + seam, right = safe.right - handleRect.right + seam;
            boolean preferLeft = handleRect.centerX() > safe.centerX();
            int room = preferLeft ? left : right;
            if (strip > room && (preferLeft ? right : left) > room) { preferLeft = !preferLeft; room = preferLeft ? left : right; }
            if (room >= dp(120)) {
                int w = Math.min(strip, room);
                int x = preferLeft ? handleRect.left - w + seam : handleRect.right - seam;
                barRect.set(x, handleRect.top, x + w, handleRect.bottom);
                attach = preferLeft ? Attach.LEFT : Attach.RIGHT;
                return;
            }
            orient(false);
            vertical = above >= below ? Attach.ABOVE : Attach.BELOW;
        }
        int h = Math.max(1, Math.min(column, vertical == Attach.ABOVE ? above : below));
        int y = vertical == Attach.ABOVE ? handleRect.top - h + seam : handleRect.bottom - seam;
        barRect.set(handleRect.left, y, handleRect.right, y + h);
        attach = vertical;
    }

    private void relayout() {
        clampHandle();
        layoutBar();
        place(handleRoot, handleParams, handleRect, barShown || barVisual ? attach : Attach.NONE, true);
        place(barRoot, barParams, barRect, attach, false);
        if (pop != Pop.NONE) positionPop();
        restyleShapes();
    }

    /** Window = card rect plus shadow room, except on the side joined to the other card. */
    private void place(View root, WindowManager.LayoutParams p, Rect card, Attach joined, boolean isHandle) {
        int s = dp(SHADOW);
        int l = s, t = s, r = s, b = s;
        if (joined == Attach.BELOW) { if (isHandle) b = 0; else t = 0; }
        else if (joined == Attach.ABOVE) { if (isHandle) t = 0; else b = 0; }
        else if (joined == Attach.LEFT) { if (isHandle) l = 0; else r = 0; }
        else if (joined == Attach.RIGHT) { if (isHandle) r = 0; else l = 0; }
        root.setPadding(l, t, r, b);
        p.x = card.left - l; p.y = card.top - t;
        p.width = card.width() + l + r; p.height = card.height() + t + b;
        update(root, p);
    }

    private static boolean inside(Rect r, MotionEvent e) {
        return r.contains(Math.round(e.getRawX()), Math.round(e.getRawY()));
    }

    // ---------- handle ----------

    /** Collapsed ⇄ open; an outside touch also closes the open toolbar. */
    private void onHandleClick() {
        if (!barShown) {
            barShown = true;
            relayout();
            animateBar(true);
        } else collapse();
    }

    private void installHandleDrag() {
        handle.setOnTouchListener(new View.OnTouchListener() {
            float downX, downY;
            int startX, startY, pointer = -1;
            boolean moved;
            final int slop = ViewConfiguration.get(context).getScaledTouchSlop();
            @Override public boolean onTouch(View view, MotionEvent event) {
                if (closed) return true;
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        pointer = event.getPointerId(0); downX = event.getRawX(); downY = event.getRawY();
                        startX = handleRect.left; startY = handleRect.top; moved = false;
                        handle.setPressed(true);
                        handle.setAlpha(1f);
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        if (event.getPointerId(0) != pointer) return true;
                        float dx = event.getRawX() - downX, dy = event.getRawY() - downY;
                        if (!moved && dx * dx + dy * dy > slop * slop) { moved = true; handle.setPressed(false); host.perform(OverlayChrome.this::dismissPop); }
                        if (moved) host.perform(() -> moveHandle(startX + Math.round(dx), startY + Math.round(dy)));
                        return true;
                    case MotionEvent.ACTION_UP:
                        handle.setPressed(false);
                        if (!(barShown || barVisual)) handle.setAlpha(COLLAPSED_ALPHA);
                        if (!moved) view.performClick();
                        else position.edit()
                            .putFloat("x", handleRect.left / (float) Math.max(1, bounds.width() - handleRect.width()))
                            .putFloat("y", handleRect.top / (float) Math.max(1, bounds.height() - handleRect.height())).apply();
                        pointer = -1; return true;
                    case MotionEvent.ACTION_CANCEL:
                        handle.setPressed(false);
                        if (!(barShown || barVisual)) handle.setAlpha(COLLAPSED_ALPHA);
                        pointer = -1; return true;
                    default: return true;
                }
            }
        });
    }

    // ---------- open/close animation (desktop toolbar-peek clip reveal) ----------

    private void cancelBarAnimation() {
        ValueAnimator running = barAnimator;
        barAnimator = null;
        if (running != null) running.cancel();
        barCard.setClipBounds(null);
        barCard.setAlpha(1f);
    }

    private void animateBar(boolean open) {
        cancelBarAnimation();
        if (open) setBarVisual(true);
        restyle();
        if (!barRoot.isAttachedToWindow()) { setBarVisual(open); return; }
        ValueAnimator animator = ValueAnimator.ofFloat(open ? 0f : 1f, open ? 1f : 0f);
        animator.setDuration(open ? OPEN_MS : CLOSE_MS);
        animator.setInterpolator(new DecelerateInterpolator());
        animator.addUpdateListener(a -> reveal((float) a.getAnimatedValue()));
        animator.addListener(new AnimatorListenerAdapter() {
            boolean cancelled;
            @Override public void onAnimationCancel(Animator a) { cancelled = true; }
            @Override public void onAnimationEnd(Animator a) {
                if (cancelled || barAnimator != animator) return;
                barAnimator = null;
                barCard.setClipBounds(null);
                barCard.setAlpha(1f);
                barCard.setElevation(dp(ELEVATION));
                if (!open) host.perform(() -> { setBarVisual(false); relayout(); restyle(); });
            }
        });
        barAnimator = animator;
        reveal(open ? 0f : 1f);
        animator.start();
    }

    /** Desktop toolbar-peek: clip-path reveal from the handle side with a 0.4→1 fade. */
    private void reveal(float f) {
        // The card may not be laid out on the first frame; its size is the bar rect.
        int w = barRect.width(), h = barRect.height();
        if (w <= 0 || h <= 0) return;
        Rect clip;
        switch (attach) {
            case ABOVE: clip = new Rect(0, Math.round(h * (1 - f)), w, h); break;
            case LEFT: clip = new Rect(Math.round(w * (1 - f)), 0, w, h); break;
            case RIGHT: clip = new Rect(0, 0, Math.round(w * f), h); break;
            default: clip = new Rect(0, 0, w, Math.round(h * f));
        }
        barCard.setClipBounds(clip);
        barCard.setAlpha(.4f + .6f * f);
        barCard.setElevation(dp(ELEVATION) * f);
    }

    // ---------- popovers ----------

    private void onProjectButton() {
        if (projects == null) { host.onProjectPicker(); closePeek(); return; }
        boolean justClosed = lastDismissed == Pop.PROJECT && android.os.SystemClock.uptimeMillis() - lastDismissedAt < 400;
        if (pop == Pop.PROJECT) dismissPop(); else if (!justClosed) showPop(Pop.PROJECT, project);
    }

    private void showPop(Pop kind, View anchor) {
        dismissPop();
        if (!barShown) return;
        pop = kind;
        popAnchor = anchor;
        rebuildPop();
        attach(popRoot, popParams);
        popCard.setAlpha(0f);
        popCard.setScaleX(.96f); popCard.setScaleY(.96f);
        popCard.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(120).start();
    }

    private void dismissPop() {
        if (pop == Pop.NONE && !added.contains(popRoot)) return;
        lastDismissed = pop;
        lastDismissedAt = android.os.SystemClock.uptimeMillis();
        pop = Pop.NONE;
        popAnchor = null;
        popCard.animate().cancel();
        remove(popRoot);
        restyle();
    }

    private void rebuildPop() {
        popCard.removeAllViews();
        int pad = dp(8);
        popCard.setPadding(pad, pad, pad, pad);
        if (pop == Pop.PEN) buildPenPop(); else if (pop == Pop.PROJECT) buildProjectPop();
        styleCard(popCard, palette.bar, palette.hairlineStrong, R_LG, Attach.NONE, false);
        popCard.setElevation(dp(ELEVATION));
        positionPop();
        restyle();
    }

    private void buildPenPop() {
        LinearLayout row = new LinearLayout(context);
        row.setGravity(Gravity.CENTER_VERTICAL);
        for (int i = 0; i < OverlayInkView.PEN_COLORS.length; i++) {
            int c = OverlayInkView.PEN_COLORS[i];
            View swatch = new View(context);
            swatch.setContentDescription(Strings.get(context, "펜 색상 {{n}}").replace("{{n}}", String.valueOf(i + 1)));
            GradientDrawable dot = new GradientDrawable();
            dot.setShape(GradientDrawable.OVAL);
            dot.setColor(c);
            if (c == penColor) dot.setStroke(dp(2.5f), palette.primary);
            else dot.setStroke(dp(1), palette.hairlineStrong);
            swatch.setBackground(dot);
            swatch.setSelected(c == penColor);
            swatch.setOnClickListener(v -> host.perform(() -> {
                penColor = c;
                pen.edit().putInt("color", c).apply();
                host.onPenColor(c);
                dismissPop();
            }));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(26), dp(26));
            lp.setMargins(dp(4), dp(4), dp(4), dp(4));
            row.addView(swatch, lp);
        }
        popCard.addView(row);
        View line = new View(context);
        line.setBackgroundColor(palette.hairline);
        LinearLayout.LayoutParams lineLp = new LinearLayout.LayoutParams(-1, dp(1));
        lineLp.setMargins(dp(4), dp(6), dp(4), dp(6));
        popCard.addView(line, lineLp);

        LinearLayout toggle = new LinearLayout(context);
        toggle.setGravity(Gravity.CENTER_VERTICAL);
        toggle.setPadding(dp(8), dp(6), dp(6), dp(6));
        toggle.setClickable(true);
        toggle.setEnabled(!inputLocked);
        toggle.setAlpha(inputLocked ? .4f : 1f);
        toggle.setContentDescription(Strings.get(context, "손가락으로도 그리기"));
        LinearLayout text = new LinearLayout(context);
        text.setOrientation(LinearLayout.VERTICAL);
        TextView title = new TextView(context);
        title.setText(Strings.get(context, "손가락으로도 그리기"));
        title.setTextSize(13);
        title.setTextColor(palette.ink);
        TextView hint = new TextView(context);
        hint.setText(Strings.get(context, finger ? "손가락과 펜 모두 필기됩니다" : "S펜만 필기, 손가락은 화면 조작"));
        hint.setTextSize(11);
        hint.setTextColor(palette.inkSubtle);
        text.addView(title);
        text.addView(hint);
        toggle.addView(text, new LinearLayout.LayoutParams(0, -2, 1));
        toggle.addView(switchPill(finger));
        toggle.setForeground(ripple(R_MD));
        toggle.setOnClickListener(v -> host.perform(() -> {
            finger = !finger;
            pen.edit().putBoolean("finger", finger).apply();
            host.onFingerDrawing(finger);
            rebuildPop();
        }));
        popCard.addView(toggle, new LinearLayout.LayoutParams(-1, -2));
    }

    private View switchPill(boolean on) {
        FrameLayout track = new FrameLayout(context);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(10));
        bg.setColor(on ? palette.primary : palette.hairlineStrong);
        track.setBackground(bg);
        View knob = new View(context);
        GradientDrawable k = new GradientDrawable();
        k.setShape(GradientDrawable.OVAL);
        k.setColor(Color.WHITE);
        knob.setBackground(k);
        FrameLayout.LayoutParams klp = new FrameLayout.LayoutParams(dp(16), dp(16), Gravity.CENTER_VERTICAL | (on ? Gravity.RIGHT : Gravity.LEFT));
        klp.setMargins(dp(2), 0, dp(2), 0);
        track.addView(knob, klp);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(36), dp(20));
        lp.leftMargin = dp(10);
        track.setLayoutParams(lp);
        return track;
    }

    private void buildProjectPop() {
        LinearLayout list = new LinearLayout(context);
        list.setOrientation(LinearLayout.VERTICAL);
        TextView head = new TextView(context);
        head.setText(Strings.get(context, "프로젝트"));
        head.setTextSize(11);
        head.setTextColor(palette.inkSubtle);
        head.setPadding(dp(8), dp(2), dp(8), dp(6));
        list.addView(head);
        if (projectLock != null) {
            TextView lock = new TextView(context);
            lock.setText(projectLock);
            lock.setTextSize(12);
            lock.setTextColor(palette.inkSubtle);
            lock.setPadding(dp(8), 0, dp(8), dp(6));
            list.addView(lock);
        }
        String group = null;
        for (Project p : projects) {
            if (p.group != null && !p.group.equals(group)) {
                group = p.group;
                TextView g = new TextView(context);
                g.setText(group);
                g.setTextSize(11);
                g.setTypeface(Typeface.DEFAULT_BOLD);
                g.setTextColor(palette.inkSubtle);
                g.setPadding(dp(8), dp(6), dp(8), dp(2));
                list.addView(g);
            }
            boolean current = p.id.equals(currentProject);
            TextView item = new TextView(context);
            item.setText((current ? "✓  " : "◈\uFE0E  ") + p.name);
            item.setTextSize(14);
            item.setSingleLine(true);
            item.setEllipsize(TextUtils.TruncateAt.END);
            item.setTextColor(current ? palette.primary : palette.ink);
            item.setPadding(dp(10), dp(9), dp(10), dp(9));
            if (current) item.setBackground(rounded(palette.primarySoft, R_MD));
            item.setForeground(ripple(R_MD));
            boolean enabled = projectLock == null;
            item.setEnabled(enabled);
            item.setAlpha(enabled || current ? 1f : .45f);
            item.setOnClickListener(v -> host.perform(() -> {
                dismissPop();
                if (!current) {
                    currentProject = p.id;
                    host.onProjectSelected(p.id);
                }
            }));
            list.addView(item, new LinearLayout.LayoutParams(-1, -2));
        }
        if (projects.isEmpty()) {
            TextView empty = new TextView(context);
            empty.setText(Strings.get(context, "PC에서 프로젝트를 만들어 주세요."));
            empty.setTextSize(13);
            empty.setTextColor(palette.inkSubtle);
            empty.setPadding(dp(8), dp(6), dp(8), dp(6));
            list.addView(empty);
        }
        ScrollView scroll = new ScrollView(context);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.addView(list);
        popCard.addView(scroll, new LinearLayout.LayoutParams(dp(220), -2));
    }

    private void positionPop() {
        if (pop == Pop.NONE || popAnchor == null) return;
        popCard.measure(View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        int w = Math.min(popCard.getMeasuredWidth(), safe.width());
        int h = Math.min(Math.min(popCard.getMeasuredHeight(), dp(360)), safe.height());
        int gap = dp(GAP);
        // Anchor position inside the bar card (scroll offset included).
        int ax = barRect.left, ay = barRect.top;
        if (popAnchor.getParent() == tools) {
            ax += tools.getLeft() + popAnchor.getLeft() - hScroll.getScrollX() * (horizontal ? 1 : 0);
            ay += tools.getTop() + popAnchor.getTop() - vScroll.getScrollY() * (horizontal ? 0 : 1);
        }
        int x, y;
        if (!horizontal) {
            boolean left = barRect.centerX() > safe.centerX();
            x = left ? barRect.left - gap - w : barRect.right + gap;
            y = ay;
        } else {
            boolean up = barRect.centerY() > safe.centerY();
            x = ax;
            y = up ? barRect.top - gap - h : barRect.bottom + gap;
        }
        x = Math.max(safe.left, Math.min(x, safe.right - w));
        y = Math.max(safe.top, Math.min(y, safe.bottom - h));
        popRect.set(x, y, x + w, y + h);
        place(popRoot, popParams, popRect, Attach.NONE, false);
    }

    // ---------- theme & styling ----------

    private Palette resolvePalette() {
        String pref = theme.getString(THEME_KEY, "system");
        switch (pref) {
            case "navy": return NAVY;
            case "white": case "light": return WHITE;
            case "ivory": case "sepia": case "forest": return IVORY;
            case "lavender": case "rose": return LAVENDER;
            case "night": case "dark": return NIGHT;
            case "system":
                return (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                    == Configuration.UI_MODE_NIGHT_YES ? NIGHT : WHITE;
            default: return NAVY;
        }
    }

    private void applyTheme() {
        Palette next = resolvePalette();
        if (next == palette) return;
        palette = next;
        if (pop != Pop.NONE) rebuildPop();
        restyle();
        host.onThemeChanged();
    }

    private void applyLanguage() {
        if (closed) return;
        handle.setContentDescription(Strings.get(context, "FASK 화면 질문 메뉴"));
        for (int i = 0; i < buttons.size(); i++) labelTool(buttons.get(i), buttonText.get(i)[0], buttonText.get(i)[1]);
        handleParams.setTitle(Strings.get(context, "FASK 토글"));
        barParams.setTitle(Strings.get(context, "FASK 도구"));
        popParams.setTitle(Strings.get(context, "FASK 선택"));
        relayout();
        if (pop != Pop.NONE) rebuildPop();
        restyle();
        host.onLanguageChanged();
    }

    private GradientDrawable rounded(int fill, int radiusDp) {
        GradientDrawable d = new GradientDrawable();
        d.setCornerRadius(dp(radiusDp));
        d.setColor(fill);
        return d;
    }

    private Drawable ripple(int radiusDp) { return ripple(radiusDp, palette.primary, 0, 0); }

    private Drawable ripple(int radiusDp, int base, int insetX, int insetY) {
        int color = (base & 0x00FFFFFF) | 0x29000000;
        Drawable mask = rounded(Color.WHITE, radiusDp);
        if (insetX != 0 || insetY != 0) mask = new InsetDrawable(mask, insetX, insetY, insetX, insetY);
        return new RippleDrawable(ColorStateList.valueOf(color), null, mask);
    }

    private void styleCard(View card, int fill, int stroke, int radiusDp, Attach joined, boolean isHandle) {
        styleCard(card, fill, stroke, radiusDp, joined, isHandle, 0, 0);
    }

    /**
     * Card fill with a 1dp ring and the joined side squared; the outline extends past it so no seam
     * shadow shows. Insets shrink the drawn card inside the view (the collapsed tile).
     */
    private void styleCard(View card, int fill, int stroke, int radiusDp, Attach joined, boolean isHandle, int insetX, int insetY) {
        float r = dp(radiusDp);
        float tl = r, tr = r, br = r, bl = r;
        Attach flat = Attach.NONE;
        if (joined == Attach.BELOW) flat = isHandle ? Attach.BELOW : Attach.ABOVE;
        else if (joined == Attach.ABOVE) flat = isHandle ? Attach.ABOVE : Attach.BELOW;
        else if (joined == Attach.LEFT) flat = isHandle ? Attach.LEFT : Attach.RIGHT;
        else if (joined == Attach.RIGHT) flat = isHandle ? Attach.RIGHT : Attach.LEFT;
        // `flat` names the side of this card that touches the other one.
        if (flat == Attach.BELOW) { br = 0; bl = 0; }
        else if (flat == Attach.ABOVE) { tl = 0; tr = 0; }
        else if (flat == Attach.LEFT) { tl = 0; bl = 0; }
        else if (flat == Attach.RIGHT) { tr = 0; br = 0; }
        GradientDrawable d = new GradientDrawable();
        d.setCornerRadii(new float[]{tl, tl, tr, tr, br, br, bl, bl});
        d.setColor(fill);
        int s = dp(1);
        d.setStroke(s, stroke);
        // The ring stops at the seam: its joined side is pushed past the window edge, which clips it.
        int il = insetX - (flat == Attach.LEFT ? s : 0), ir = insetX - (flat == Attach.RIGHT ? s : 0);
        int it = insetY - (flat == Attach.ABOVE ? s : 0), ib = insetY - (flat == Attach.BELOW ? s : 0);
        card.setBackground(il == 0 && ir == 0 && it == 0 && ib == 0 ? d : new InsetDrawable(d, il, it, ir, ib));
        final Attach side = flat;
        final int radius = Math.round(r);
        card.setOutlineProvider(new ViewOutlineProvider() {
            @Override public void getOutline(View view, Outline outline) {
                int w = view.getWidth() - insetX, h = view.getHeight() - insetY;
                if (side == Attach.BELOW) outline.setRoundRect(insetX, insetY, w, h + radius, radius);
                else if (side == Attach.ABOVE) outline.setRoundRect(insetX, insetY - radius, w, h, radius);
                else if (side == Attach.LEFT) outline.setRoundRect(insetX - radius, insetY, w, h, radius);
                else if (side == Attach.RIGHT) outline.setRoundRect(insetX, insetY, w + radius, h, radius);
                else outline.setRoundRect(insetX, insetY, w, h, radius);
            }
        });
        if (Build.VERSION.SDK_INT >= 28) {
            card.setOutlineAmbientShadowColor(0xFF000000);
            card.setOutlineSpotShadowColor(0xFF000000);
        }
    }

    private void restyleShapes() {
        Attach joined = barShown || barVisual ? attach : Attach.NONE;
        if (joined == Attach.NONE) {
            int ix = Math.max(0, (handleRect.width() - dp(TILE)) / 2), iy = Math.max(0, (handleRect.height() - dp(TILE)) / 2);
            styleCard(handle, palette.tb, palette.ring, R_TB, Attach.NONE, true, ix, iy);
            handle.setShape(ix, iy, 22, ToggleMarkView.Side.NONE);
            handle.setForeground(ripple(R_TB, palette.tbInk, ix, iy));
            handle.setAlpha(COLLAPSED_ALPHA);
        } else {
            styleCard(handle, palette.tb, palette.ring, R_TB, joined, true);
            ToggleMarkView.Side seam = joined == Attach.BELOW ? ToggleMarkView.Side.BOTTOM
                : joined == Attach.ABOVE ? ToggleMarkView.Side.TOP
                : joined == Attach.LEFT ? ToggleMarkView.Side.LEFT : ToggleMarkView.Side.RIGHT;
            handle.setShape(0, 0, 24, seam);
            handle.setForeground(ripple(R_TB, palette.tbInk, 0, 0));
            handle.setAlpha(1f);
        }
        handle.setElevation(dp(ELEVATION));
        styleCard(barCard, palette.tb, palette.ring, R_TB, attach, false);
        if (barAnimator == null) barCard.setElevation(dp(ELEVATION));
    }

    private void restyle() {
        if (closed) return;
        // The period follows the pen colour while drawing (desktop MarkF dot), else the theme logo accent.
        handle.setColors(palette.tbInk, mode == OverlayWindowController.Mode.PEN ? penColor : palette.logo);
        for (View line : dividers) line.setBackgroundColor((palette.tbInk & 0x00FFFFFF) | 0x24000000);
        for (LinearLayout b : buttons) styleTool(b, false);
        styleTool(penButton, mode == OverlayWindowController.Mode.PEN);
        styleTool(eraser, mode == OverlayWindowController.Mode.ERASER);
        styleTool(region, mode == OverlayWindowController.Mode.REGION);
        styleTool(question, panelOpen);
        styleTool(project, pop == Pop.PROJECT);
        ((ToolIconView) penButton.getChildAt(0)).setInk(penColor);
        for (View b : new View[]{penButton, eraser, clear, region}) {
            b.setEnabled(editable);
            b.setAlpha(editable ? 1f : .4f);
        }
        restyleShapes();
    }

    /** Toolbar button: tool ink on the bar, the theme selected fill (--tb-on) when active. */
    private void styleTool(LinearLayout button, boolean active) {
        button.setBackground(active ? rounded(palette.tbOn, R_MD) : null);
        button.setForeground(ripple(R_MD, palette.tbInk, 0, 0));
        int color = active ? palette.tbOnInk : palette.tbInk;
        ((ToolIconView) button.getChildAt(0)).setColor(color);
        ((TextView) button.getChildAt(1)).setTextColor(color);
    }

    // ---------- windows ----------

    // isAttachedToWindow() turns true only after the next traversal, so an add followed by
    // remove/add in the same frame needs explicit bookkeeping.
    private final java.util.Set<View> added = new java.util.HashSet<>();
    private void attach(View view, WindowManager.LayoutParams p) { if (added.add(view)) windows.addView(view, p); }
    private void remove(View view) { if (added.remove(view)) windows.removeViewImmediate(view); }
    private void update(View view, WindowManager.LayoutParams p) { if (added.contains(view)) windows.updateViewLayout(view, p); }
}
