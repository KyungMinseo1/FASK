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
    }

    static final class Project {
        final String id, name, group;
        Project(String id, String name, String group) { this.id = id; this.name = name; this.group = group; }
    }

    static final String THEME_PREFS = "overlay_theme";
    static final String THEME_KEY = "pref";
    private static final int R_MD = 8, R_LG = 12, R_XL = 16;
    private static final int HANDLE_W = 64, HANDLE_H = 58;
    private static final int SHADOW = 10, ELEVATION = 6, GAP = 8;
    private static final int OPEN_MS = 180, CLOSE_MS = 130;

    private enum Attach { NONE, BELOW, ABOVE, LEFT, RIGHT }
    private enum Pop { NONE, PEN, PROJECT }

    /** personal.css :root / [data-theme='dark'] tokens. */
    static final class Palette {
        final int bar, hairline, hairlineStrong, ink, inkSubtle, primary, primaryPressed, primarySoft, brand, pressed, collapsedBorder;
        Palette(int bar, int hairline, int hairlineStrong, int ink, int inkSubtle, int primary, int primaryPressed,
                int primarySoft, int brand, int pressed, int collapsedBorder) {
            this.bar = bar; this.hairline = hairline; this.hairlineStrong = hairlineStrong; this.ink = ink;
            this.inkSubtle = inkSubtle; this.primary = primary; this.primaryPressed = primaryPressed;
            this.primarySoft = primarySoft; this.brand = brand; this.pressed = pressed; this.collapsedBorder = collapsedBorder;
        }
    }
    private static final Palette LIGHT = new Palette(0xFFFFFFFF, 0xFFE3E6EF, 0xFFD3D7E4, 0xFF20283C, 0xFF7B849E,
        0xFF5B51DF, 0xFF4E45C9, 0xFFF1EFFE, 0xFF5B51DF, 0xFFF1F2F8, 0x1420283C);
    private static final Palette DARK = new Palette(0xFF161A2B, 0xFF262C40, 0xFF323A52, 0xFFE6E9F5, 0xFF8A93AD,
        0xFF7B72F0, 0xFF6A61E0, 0xFF241F4A, 0xFFA59BFF, 0xFF20263A, 0x14FFFFFF);

    private final Context context;
    private final WindowManager windows;
    private final Host host;
    private final SharedPreferences position, pen, theme;
    private final SharedPreferences.OnSharedPreferenceChangeListener themeListener;
    private final ComponentCallbacks configListener;
    private int densityDpi;
    private Palette palette = LIGHT;

    private final FrameLayout handleRoot, barRoot, popRoot;
    private final TextView handle;
    private final FrameLayout barCard;
    private final LinearLayout popCard;
    private final ScrollView vScroll;
    private final HorizontalScrollView hScroll;
    private final LinearLayout tools;
    private final WindowManager.LayoutParams handleParams, barParams, popParams;
    private final LinearLayout penButton, eraser, clear, question, dashboard, region, project, stop;
    private final List<LinearLayout> buttons = new ArrayList<>();
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

        handle = new TextView(context);
        handle.setText("f");
        handle.setTypeface(Typeface.create(Typeface.SERIF, Typeface.BOLD_ITALIC));
        handle.setTextSize(28);
        handle.setGravity(Gravity.CENTER);
        handle.setContentDescription("FASK 화면 질문 메뉴");
        handle.setOnClickListener(v -> host.perform(this::onHandleClick));
        handle.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
            if (!closed && handle.isAttachedToWindow() && handle.getWidth() > 0) host.onHandleReady();
        });
        installHandleDrag();
        handleRoot = root(handle);
        handleParams = params("FASK 토글", false);

        tools = new LinearLayout(context);
        int pad = dp(6);
        tools.setPadding(pad, pad, pad, pad);
        penButton = tool("✎", "펜", "펜", host::onPen);
        eraser = tool("▱", "지우개", "지우개", host::onEraser);
        clear = tool("⌫", "모두 지우기", "모두 지우기", host::onClearInk);
        divider();
        question = tool("？", "질문", "질문 · 앱 열기", () -> { host.onQuestion(); closePeek(); });
        dashboard = tool("▦", "대시보드", "대시보드", () -> { host.onDashboard(); closePeek(); });
        region = tool("▣", "캡처 영역", "캡처 영역 선택", () -> { host.onRegion(); closePeek(); });
        divider();
        project = tool("◈", "프로젝트", "프로젝트 바꾸기", this::onProjectButton);
        divider();
        stop = tool("✕", "종료", "FASK 화면 질문 종료", host::onStop);
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
        barParams = params("FASK 도구", true);
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
        popParams = params("FASK 선택", true);
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

        themeListener = (prefs, key) -> { if (THEME_KEY.equals(key)) host.perform(this::applyTheme); };
        theme.registerOnSharedPreferenceChangeListener(themeListener);
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
        bounds.set(displayBounds);
        safe.set(safeBounds);
        int w = Math.min(dp(HANDLE_W), safe.width()), h = Math.min(dp(HANDLE_H), safe.height());
        handleRect.set(handleRect.left, handleRect.top, handleRect.left + w, handleRect.top + h);
        relayout();
    }

    Palette palette() { return palette; }
    boolean isDark() { return palette == DARK; }
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

    void close() {
        if (closed) return;
        closed = true;
        cancelBarAnimation();
        theme.unregisterOnSharedPreferenceChangeListener(themeListener);
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

    private LinearLayout tool(String glyph, String label, String description, Runnable action) {
        LinearLayout button = new LinearLayout(context);
        button.setOrientation(LinearLayout.VERTICAL);
        button.setGravity(Gravity.CENTER);
        button.setPadding(dp(2), dp(4), dp(2), dp(4));
        button.setClickable(true);
        button.setContentDescription(description);
        TextView g = new TextView(context);
        // U+FE0E asks for the monochrome text glyph; Android otherwise picks colour emoji.
        g.setText(glyph + "\uFE0E");
        g.setTextSize(19);
        g.setGravity(Gravity.CENTER);
        g.setIncludeFontPadding(false);
        TextView l = new TextView(context);
        l.setText(label);
        l.setTextSize(10.5f);
        l.setMaxLines(1);
        l.setGravity(Gravity.CENTER);
        l.setIncludeFontPadding(false);
        l.setPadding(0, dp(3), 0, 0);
        // Shrink long labels (모두 지우기) to the 64dp card's inner width instead of clipping.
        int inner = dp(HANDLE_W - 16);
        for (float sp = 10.5f; sp > 8 && l.getPaint().measureText(label) > inner; sp -= .5f) l.setTextSize(sp - .5f);
        button.addView(g);
        button.addView(l);
        button.setOnClickListener(v -> host.perform(action));
        tools.addView(button);
        buttons.add(button);
        return button;
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
        if (strip) tools.setPadding(dp(6), dp(3), dp(6), dp(3)); else tools.setPadding(dp(6), dp(6), dp(6), dp(6));
        for (LinearLayout b : buttons) {
            if (strip) b.setPadding(dp(2), dp(1), dp(2), dp(1)); else b.setPadding(dp(2), dp(4), dp(2), dp(4));
        }
        for (int i = 0; i < tools.getChildCount(); i++) {
            View child = tools.getChildAt(i);
            LinearLayout.LayoutParams lp;
            if (dividers.contains(child)) {
                lp = strip ? new LinearLayout.LayoutParams(dp(1), -1) : new LinearLayout.LayoutParams(-1, dp(1));
                if (strip) lp.setMargins(dp(4), dp(6), dp(4), dp(6)); else lp.setMargins(dp(4), dp(4), dp(4), dp(4));
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
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        if (event.getPointerId(0) != pointer) return true;
                        float dx = event.getRawX() - downX, dy = event.getRawY() - downY;
                        if (!moved && dx * dx + dy * dy > slop * slop) { moved = true; handle.setPressed(false); host.perform(OverlayChrome.this::dismissPop); }
                        if (moved) host.perform(() -> moveHandle(startX + Math.round(dx), startY + Math.round(dy)));
                        return true;
                    case MotionEvent.ACTION_UP:
                        handle.setPressed(false);
                        if (!moved) view.performClick();
                        else position.edit()
                            .putFloat("x", handleRect.left / (float) Math.max(1, bounds.width() - handleRect.width()))
                            .putFloat("y", handleRect.top / (float) Math.max(1, bounds.height() - handleRect.height())).apply();
                        pointer = -1; return true;
                    case MotionEvent.ACTION_CANCEL: handle.setPressed(false); pointer = -1; return true;
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
            swatch.setContentDescription("펜 색상 " + (i + 1));
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
        toggle.setContentDescription("손가락으로도 그리기");
        LinearLayout text = new LinearLayout(context);
        text.setOrientation(LinearLayout.VERTICAL);
        TextView title = new TextView(context);
        title.setText("손가락으로도 그리기");
        title.setTextSize(13);
        title.setTextColor(palette.ink);
        TextView hint = new TextView(context);
        hint.setText(finger ? "손가락과 펜 모두 필기됩니다" : "S펜만 필기 · 손가락은 화면 조작");
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
        head.setText("프로젝트");
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
            empty.setText("PC에서 프로젝트를 만들어 주세요.");
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
        boolean dark = "dark".equals(pref) || (!"light".equals(pref)
            && (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES);
        return dark ? DARK : LIGHT;
    }

    private void applyTheme() {
        Palette next = resolvePalette();
        if (next == palette) return;
        palette = next;
        if (pop != Pop.NONE) rebuildPop();
        restyle();
        host.onThemeChanged();
    }

    private GradientDrawable rounded(int fill, int radiusDp) {
        GradientDrawable d = new GradientDrawable();
        d.setCornerRadius(dp(radiusDp));
        d.setColor(fill);
        return d;
    }

    private Drawable ripple(int radiusDp) {
        int color = (palette.primary & 0x00FFFFFF) | 0x29000000;
        return new RippleDrawable(ColorStateList.valueOf(color), null, rounded(Color.WHITE, radiusDp));
    }

    /** Card fill/stroke with the joined side squared; the outline extends past it so no seam shadow shows. */
    private void styleCard(View card, int fill, int stroke, int radiusDp, Attach joined, boolean isHandle) {
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
        d.setStroke(dp(1), stroke);
        card.setBackground(d);
        final Attach side = flat;
        final int radius = Math.round(r);
        card.setOutlineProvider(new ViewOutlineProvider() {
            @Override public void getOutline(View view, Outline outline) {
                int w = view.getWidth(), h = view.getHeight();
                if (side == Attach.BELOW) outline.setRoundRect(0, 0, w, h + radius, radius);
                else if (side == Attach.ABOVE) outline.setRoundRect(0, -radius, w, h, radius);
                else if (side == Attach.LEFT) outline.setRoundRect(-radius, 0, w, h, radius);
                else if (side == Attach.RIGHT) outline.setRoundRect(0, 0, w + radius, h, radius);
                else outline.setRoundRect(0, 0, w, h, radius);
            }
        });
        if (Build.VERSION.SDK_INT >= 28) {
            int shadow = palette == DARK ? 0xFF000000 : 0xFF1A1F3A;
            card.setOutlineAmbientShadowColor(shadow);
            card.setOutlineSpotShadowColor(shadow);
        }
    }

    private void restyleShapes() {
        Attach joined = barShown || barVisual ? attach : Attach.NONE;
        if (joined == Attach.NONE) {
            styleCard(handle, palette.bar, palette.collapsedBorder, R_LG, Attach.NONE, true);
            handle.setElevation(dp(4));
            handle.setAlpha(.92f);
        } else {
            styleCard(handle, palette.bar, palette.hairlineStrong, R_XL, joined, true);
            handle.setElevation(dp(ELEVATION));
            handle.setAlpha(1f);
        }
        styleCard(barCard, palette.bar, palette.hairlineStrong, R_XL, attach, false);
        if (barAnimator == null) barCard.setElevation(dp(ELEVATION));
    }

    private void restyle() {
        if (closed) return;
        handle.setTextColor(palette.brand);
        handle.setForeground(ripple(R_LG));
        for (View line : dividers) line.setBackgroundColor(palette.hairline);
        for (LinearLayout b : buttons) styleTool(b, false);
        styleTool(penButton, mode == OverlayWindowController.Mode.PEN);
        styleTool(eraser, mode == OverlayWindowController.Mode.ERASER);
        styleTool(region, mode == OverlayWindowController.Mode.REGION);
        styleTool(project, pop == Pop.PROJECT);
        ((TextView) penButton.getChildAt(0)).setTextColor(penColor);
        question.setBackground(rounded(panelOpen ? palette.primaryPressed : palette.primary, R_MD));
        ((TextView) question.getChildAt(0)).setTextColor(Color.WHITE);
        ((TextView) question.getChildAt(1)).setTextColor(Color.WHITE);
        for (View b : new View[]{penButton, eraser, clear, region}) {
            b.setEnabled(editable);
            b.setAlpha(editable ? 1f : .4f);
        }
        restyleShapes();
    }

    private void styleTool(LinearLayout button, boolean active) {
        button.setBackground(active ? rounded(palette.primarySoft, R_MD) : null);
        button.setForeground(ripple(R_MD));
        int color = active ? palette.primary : palette.inkSubtle;
        ((TextView) button.getChildAt(0)).setTextColor(color);
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
