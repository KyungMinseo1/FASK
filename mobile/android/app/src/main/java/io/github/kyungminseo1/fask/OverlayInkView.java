package io.github.kyungminseo1.fask;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.graphics.RectF;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Display-local ink and a transactional region editor; never forwards ignored palm input. */
public final class OverlayInkView extends View {
    public interface Listener {
        void onRevisionChanged();
        void onRegionConfirmed();
        void onRegionCancelled();
        void onGeometryMeasured(int x, int y, int width, int height);
        /** A confirmed selection, in display-local pixels, for the controller to persist. */
        void onRegionSaved(RectF region);
    }

    /** An immutable capture copy. The path and its width are already in display logical pixels. */
    public static final class Stroke {
        private final Path path;
        private final float[] points;
        public final float widthPx;
        public final int color;
        private Stroke(Path path, float[] points, float widthPx, int color) {
            this.path = new Path(path);
            if (points.length > 2) this.path.lineTo(points[points.length - 2], points[points.length - 1]);
            this.points = points;
            this.widthPx = widthPx;
            this.color = color;
        }
        public void draw(Canvas canvas, Paint paint) {
            paint.setColor(color);
            paint.setStrokeWidth(widthPx);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeJoin(Paint.Join.ROUND);
            paint.setStyle(Paint.Style.STROKE);
            if (points.length == 2) {
                paint.setStyle(Paint.Style.FILL);
                canvas.drawCircle(points[0], points[1], widthPx / 2, paint);
            } else canvas.drawPath(path, paint);
        }
    }

    private final Listener listener;
    private final ArrayList<Stroke> strokes = new ArrayList<>();
    private float[] activePoints = new float[256];
    private int pointCount;
    private final Path activePath = new Path();
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF confirmButton = new RectF();
    private final RectF cancelButton = new RectF();
    private final Rect toolBounds = new Rect();
    private final RectF buttonDrawRect = new RectF();
    private int activeTool;
    private final int[] location = new int[2];
    private OverlayGeometry.GeometrySnapshot geometry;
    private OverlayWindowController.Mode mode = OverlayWindowController.Mode.IDLE;
    private boolean fingerDrawing;
    private boolean locked;
    private int activePointer = -1;
    private boolean erasing;
    private float strokeWidth;
    private float eraserRadius;
    private boolean hasErasePoint;
    private float lastEraseX, lastEraseY;
    private RectF region;
    private RectF draft;
    private long regionEpoch = -1;
    private long revision;
    private int regionDrag;
    private float downX, downY;
    private RectF dragStart;
    private int pendingButton;
    private int lastOriginX = Integer.MIN_VALUE, lastOriginY = Integer.MIN_VALUE;
    private int lastWidth = -1, lastHeight = -1;
    public static final int[] PEN_COLORS = {0xffef4444, 0xfff97316, 0xffeab308, 0xff22c55e, 0xff3b82f6, 0xff8b5cf6, 0xffec4899, 0xff111827};
    private int penColor = PEN_COLORS[0];

    public void setPenColor(int color) { penColor = color; }

    public OverlayInkView(Context context, Listener listener) {
        super(context);
        this.listener = listener;
        setFocusableInTouchMode(true);
        setContentDescription(Strings.get(context, "FASK 펜 및 캡처 영역 편집"));
        addOnLayoutChangeListener((view, l, t, r, b, ol, ot, or, ob) -> reportGeometry());
        getViewTreeObserver().addOnGlobalLayoutListener(this::reportGeometry);
    }

    private float dp(float value) { return value * (geometry == null ? getResources().getDisplayMetrics().density : geometry.densityDpi / 160f); }

    public void setGeometry(OverlayGeometry.GeometrySnapshot next) {
        geometry = next;
        strokeWidth = dp(4);
        eraserRadius = dp(12);
        invalidate();
    }
    public void setToolBounds(Rect bounds) { toolBounds.set(bounds); invalidate(); }


    public void reportGeometry() {
        if (!isAttachedToWindow() || getWidth() <= 0 || getHeight() <= 0) return;
        getLocationOnScreen(location);
        if (location[0] == lastOriginX && location[1] == lastOriginY && getWidth() == lastWidth && getHeight() == lastHeight) return;
        lastOriginX = location[0]; lastOriginY = location[1]; lastWidth = getWidth(); lastHeight = getHeight();
        listener.onGeometryMeasured(location[0], location[1], getWidth(), getHeight());
    }

    public void setMode(OverlayWindowController.Mode next) {
        discardGesture();
        mode = next;
        if (next == OverlayWindowController.Mode.REGION) draft = region == null ? null : new RectF(region);
        else draft = null;
        invalidate();
    }

    public void setFingerDrawing(boolean enabled) { fingerDrawing = enabled; }
    public void setInteractionLocked(boolean value) { locked = value; if (value) discardGesture(); }
    public long getRevision() { return revision; }
    public boolean hasInk() { return !strokes.isEmpty(); }
    public RectF getRegion() { return region == null ? null : new RectF(region); }
    public long getRegionEpoch() { return regionEpoch; }
    public List<Stroke> snapshotStrokes() { return Collections.unmodifiableList(new ArrayList<>(strokes)); }

    public boolean clearInk(long expectedRevision) {
        if (locked || expectedRevision != revision || strokes.isEmpty()) return false;
        strokes.clear();
        changed();
        return true;
    }

    public void clearInk() {
        if (locked) return;
        discardGesture();
        if (!strokes.isEmpty()) { strokes.clear(); changed(); }
    }

    /** Ink is tied to the old geometry; the region is kept for the controller to restore or clear. */
    public void invalidateGeometry() {
        discardGesture();
        strokes.clear(); draft = null;
        regionEpoch = region == null ? -1 : geometry.epoch;
        changed();
    }

    /** Installs a saved selection for the current geometry; null clears it. */
    public void restoreRegion(RectF r) {
        discardGesture();
        region = r == null ? null : new RectF(r);
        regionEpoch = r == null ? -1 : geometry.epoch;
        draft = mode == OverlayWindowController.Mode.REGION && region != null ? new RectF(region) : null;
        changed();
    }

    private void changed() { revision++; invalidate(); listener.onRevisionChanged(); }

    private void discardGesture() {
        activePointer = -1; pointCount = 0; activePath.reset(); regionDrag = 0; pendingButton = 0;
        hasErasePoint = false;
        invalidate();
    }

    private float displayX(float local) {
        return local + (float) geometry.inkOriginPx.x - geometry.displayBoundsPx.left;
    }
    private float displayY(float local) {
        return local + (float) geometry.inkOriginPx.y - geometry.displayBoundsPx.top;
    }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (geometry == null) return;
        canvas.save();
        canvas.translate((float) (geometry.displayBoundsPx.left - geometry.inkOriginPx.x),
            (float) (geometry.displayBoundsPx.top - geometry.inkOriginPx.y));
        for (Stroke stroke : strokes) stroke.draw(canvas, paint);
        if (pointCount > 0) {
            paint.setColor(penColor); paint.setStrokeWidth(strokeWidth);
            paint.setStrokeCap(Paint.Cap.ROUND); paint.setStrokeJoin(Paint.Join.ROUND); paint.setStyle(Paint.Style.STROKE);
            if (pointCount == 2) {
                paint.setStyle(Paint.Style.FILL);
                canvas.drawCircle(activePoints[0], activePoints[1], strokeWidth / 2, paint);
            } else {
                canvas.drawPath(activePath, paint);
                float tailX = pointCount == 4 ? activePoints[0] : (activePoints[pointCount - 4] + activePoints[pointCount - 2]) / 2;
                float tailY = pointCount == 4 ? activePoints[1] : (activePoints[pointCount - 3] + activePoints[pointCount - 1]) / 2;
                canvas.drawLine(tailX, tailY, activePoints[pointCount - 2], activePoints[pointCount - 1], paint);
            }
        }
        if (mode == OverlayWindowController.Mode.REGION) drawRegion(canvas);
        canvas.restore();
    }

    private void drawRegion(Canvas canvas) {
        float width = geometry.displayBoundsPx.width(), height = geometry.displayBoundsPx.height();
        paint.setStyle(Paint.Style.FILL); paint.setColor(0x88000000);
        if (draft == null) canvas.drawRect(0, 0, width, height, paint);
        else {
            canvas.drawRect(0, 0, width, draft.top, paint);
            canvas.drawRect(0, draft.bottom, width, height, paint);
            canvas.drawRect(0, draft.top, draft.left, draft.bottom, paint);
            canvas.drawRect(draft.right, draft.top, width, draft.bottom, paint);
            paint.setColor(0xff60a5fa); paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(dp(2));
            canvas.drawRect(draft, paint);
            paint.setStyle(Paint.Style.FILL);
            for (int i = 0; i < 8; i++) canvas.drawCircle(handleX(i), handleY(i), dp(5), paint);
        }
        // These are view-local hit targets, mapped once into display coordinates for drawing.
        float center = toolBounds.centerX() - (float) geometry.inkOriginPx.x + geometry.displayBoundsPx.left;
        float buttonWidth = Math.min(dp(100), toolBounds.width() / 3f);
        float top = toolBounds.bottom - (float) geometry.inkOriginPx.y + geometry.displayBoundsPx.top - dp(60);
        cancelButton.set(center - buttonWidth - dp(6), top, center - dp(6), top + dp(48));
        confirmButton.set(center + dp(6), top, center + dp(6) + buttonWidth, top + dp(48));
        Context context = getContext();
        drawButton(canvas, cancelButton, Strings.get(context, "취소"), true);
        drawButton(canvas, confirmButton, Strings.get(context, "확인"), draft != null && validRegion(draft));
        paint.setColor(0xffffffff); paint.setTextSize(dp(15)); paint.setTextAlign(Paint.Align.CENTER);
        canvas.drawText(Strings.get(context, "드래그하여 영역 선택 · 가장자리로 크기 조절"), displayX(getWidth() / 2f), displayY(Math.max(dp(28), top - dp(16))), paint);
    }

    private void drawButton(Canvas canvas, RectF local, String text, boolean enabled) {
        RectF rect = buttonDrawRect;
        rect.set(displayX(local.left), displayY(local.top), displayX(local.right), displayY(local.bottom));
        paint.setStyle(Paint.Style.FILL); paint.setColor(enabled ? 0xff1d4ed8 : 0xff475569);
        canvas.drawRoundRect(rect, dp(8), dp(8), paint);
        paint.setColor(0xffffffff); paint.setTextSize(dp(16)); paint.setTextAlign(Paint.Align.CENTER);
        canvas.drawText(text, rect.centerX(), rect.centerY() - (paint.ascent() + paint.descent()) / 2, paint);
    }

    private float handleX(int i) { return i == 0 || i == 6 || i == 7 ? draft.left : i == 2 || i == 3 || i == 4 ? draft.right : draft.centerX(); }
    private float handleY(int i) { return i <= 2 ? draft.top : i >= 4 && i <= 6 ? draft.bottom : draft.centerY(); }
    private boolean validRegion(RectF rect) { return rect.width() >= dp(24) && rect.height() >= dp(24); }

    @Override public boolean onTouchEvent(MotionEvent event) {
        if (locked || geometry == null) return true;
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_CANCEL) { discardGesture(); return true; }
        if (action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_POINTER_DOWN) {
            int index = event.getActionIndex();
            int tool = event.getToolType(index);
            if (activePointer != -1) {
                // A pen arriving while an enabled finger is drawing takes ownership; discard the palm stroke.
                if (activeTool == MotionEvent.TOOL_TYPE_FINGER && mode != OverlayWindowController.Mode.REGION
                    && (tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER)) discardGesture();
                else return true;
            }
            if (mode != OverlayWindowController.Mode.REGION && tool != MotionEvent.TOOL_TYPE_STYLUS
                && tool != MotionEvent.TOOL_TYPE_ERASER && !(fingerDrawing && tool == MotionEvent.TOOL_TYPE_FINGER)) return true;
            if (mode != OverlayWindowController.Mode.PEN && mode != OverlayWindowController.Mode.ERASER
                && mode != OverlayWindowController.Mode.REGION) return true;
            activePointer = event.getPointerId(index);
            activeTool = tool;
            erasing = mode == OverlayWindowController.Mode.ERASER || tool == MotionEvent.TOOL_TYPE_ERASER;
            float x = displayX(event.getX(index)), y = displayY(event.getY(index));
            if (mode == OverlayWindowController.Mode.REGION) startRegion(event.getX(index), event.getY(index), x, y);
            else if (erasing) sample(x, y);
            else addPoint(x, y);
            return true;
        }
        int index = event.findPointerIndex(activePointer);
        if (index < 0) return true;
        boolean up = (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_POINTER_UP)
            && event.getPointerId(event.getActionIndex()) == activePointer;
        if (action == MotionEvent.ACTION_MOVE || up) {
            if (mode == OverlayWindowController.Mode.REGION) updateRegion(displayX(event.getX(index)), displayY(event.getY(index)));
            else {
                for (int h = 0; h < event.getHistorySize(); h++) sample(displayX(event.getHistoricalX(index, h)), displayY(event.getHistoricalY(index, h)));
                sample(displayX(event.getX(index)), displayY(event.getY(index)));
            }
            if (up) {
                if (mode == OverlayWindowController.Mode.REGION) finishRegion(event.getX(index), event.getY(index));
                else if (!erasing && pointCount > 0) {
                    strokes.add(new Stroke(activePath, Arrays.copyOf(activePoints, pointCount), strokeWidth, penColor));
                    changed();
                }
                discardGesture();
            }
        }
        return true;
    }

    private void sample(float x, float y) {
        if (!erasing) { addPoint(x, y); return; }
        if (hasErasePoint) {
            float dx = x - lastEraseX, dy = y - lastEraseY;
            int steps = Math.max(1, (int) Math.ceil(Math.hypot(dx, dy) / (eraserRadius / 2)));
            for (int i = 1; i < steps; i++) eraseAt(lastEraseX + dx * i / steps, lastEraseY + dy * i / steps);
        }
        eraseAt(x, y);
        lastEraseX = x; lastEraseY = y; hasErasePoint = true;
    }
    private void addPoint(float x, float y) {
        if (pointCount >= 2 && activePoints[pointCount - 2] == x && activePoints[pointCount - 1] == y) return;
        if (pointCount + 2 > activePoints.length) activePoints = Arrays.copyOf(activePoints, activePoints.length * 2);
        // Append only the new midpoint quadratic. The terminal segment stays separate until commit.
        if (pointCount == 0) activePath.moveTo(x, y);
        else if (pointCount >= 4) activePath.quadTo(activePoints[pointCount - 2], activePoints[pointCount - 1],
            (activePoints[pointCount - 2] + x) / 2, (activePoints[pointCount - 1] + y) / 2);
        activePoints[pointCount++] = x; activePoints[pointCount++] = y;
        invalidate();
    }

    private void eraseAt(float x, float y) {
        boolean removed = false;
        for (int i = strokes.size() - 1; i >= 0; i--) {
            Stroke stroke = strokes.get(i);
            float radius = eraserRadius + stroke.widthPx / 2;
            boolean hit = false;
            for (int p = 0; p < stroke.points.length; p += 2) {
                float ax = stroke.points[p], ay = stroke.points[p + 1];
                float bx = p + 2 < stroke.points.length ? stroke.points[p + 2] : ax;
                float by = p + 3 < stroke.points.length ? stroke.points[p + 3] : ay;
                float dx = bx - ax, dy = by - ay;
                float length = dx * dx + dy * dy;
                float t = length == 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length));
                float ex = x - ax - t * dx, ey = y - ay - t * dy;
                if (ex * ex + ey * ey <= radius * radius) { hit = true; break; }
            }
            if (hit) { strokes.remove(i); removed = true; }
        }
        if (removed) changed();
    }

    private void startRegion(float localX, float localY, float x, float y) {
        x = Math.max(0, Math.min(geometry.displayBoundsPx.width(), x));
        y = Math.max(0, Math.min(geometry.displayBoundsPx.height(), y));
        downX = x; downY = y;
        if (cancelButton.contains(localX, localY)) { pendingButton = 1; return; }
        if (confirmButton.contains(localX, localY)) { pendingButton = 2; return; }
        regionDrag = 0;
        if (draft != null) {
            float radius = Math.min(dp(20), Math.min(draft.width(), draft.height()) / 4);
            for (int i = 0; i < 8; i++) {
                if (Math.abs(x - handleX(i)) <= radius && Math.abs(y - handleY(i)) <= radius) { regionDrag = i + 1; break; }
            }
            if (regionDrag == 0 && draft.contains(x, y)) regionDrag = 9;
        }
        if (regionDrag == 0) { draft = new RectF(x, y, x, y); regionDrag = 10; }
        dragStart = new RectF(draft);
        invalidate();
    }

    private void updateRegion(float x, float y) {
        if (pendingButton != 0 || draft == null || dragStart == null) return;
        float w = geometry.displayBoundsPx.width(), h = geometry.displayBoundsPx.height();
        x = Math.max(0, Math.min(w, x)); y = Math.max(0, Math.min(h, y));
        float min = dp(24);
        if (regionDrag == 10) draft.set(Math.min(downX, x), Math.min(downY, y), Math.max(downX, x), Math.max(downY, y));
        else if (regionDrag == 9) {
            float dx = Math.max(-dragStart.left, Math.min(w - dragStart.right, x - downX));
            float dy = Math.max(-dragStart.top, Math.min(h - dragStart.bottom, y - downY));
            draft.set(dragStart); draft.offset(dx, dy);
        } else {
            draft.set(dragStart);
            int handle = regionDrag - 1;
            if (handle == 0 || handle == 6 || handle == 7) draft.left = Math.min(x, draft.right - min);
            if (handle == 2 || handle == 3 || handle == 4) draft.right = Math.max(x, draft.left + min);
            if (handle <= 2) draft.top = Math.min(y, draft.bottom - min);
            if (handle >= 4 && handle <= 6) draft.bottom = Math.max(y, draft.top + min);
        }
        invalidate();
    }

    private void finishRegion(float localX, float localY) {
        if (pendingButton == 0 && draft != null) {
            OverlayGeometry.RegionRect clamped = OverlayGeometry.clampRegion(geometry,
                new OverlayGeometry.RegionRect(draft.left, draft.top, draft.right, draft.bottom), dp(24), dp(24));
            draft.set((float) clamped.left, (float) clamped.top, (float) clamped.right, (float) clamped.bottom);
        }
        if (pendingButton == 1 && cancelButton.contains(localX, localY)) { listener.onRegionCancelled(); return; }
        if (pendingButton == 2 && confirmButton.contains(localX, localY) && draft != null && validRegion(draft)) {
            region = new RectF(draft); regionEpoch = geometry.epoch; changed();
            listener.onRegionSaved(new RectF(region));
            listener.onRegionConfirmed();
        }
    }

    @Override public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) { listener.onRegionCancelled(); return true; }
        return super.onKeyUp(keyCode, event);
    }
}
