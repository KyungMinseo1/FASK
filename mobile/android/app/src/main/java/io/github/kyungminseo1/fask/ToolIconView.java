package io.github.kyungminseo1.fask;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.view.View;

import androidx.core.graphics.PathParser;

import java.util.ArrayList;
import java.util.List;

/**
 * Overlay toolbar icon: the same 24-unit line drawings as the desktop toolbar (ToolbarIcons.tsx),
 * stroked in the tool colour. The pen's trailing line uses the current pen colour.
 */
final class ToolIconView extends View {
    enum Kind { PEN, ERASER, CLEAR, QUESTION, DASHBOARD, REGION, PROJECT, STOP }

    private static final float UNITS = 24f, STROKE = 1.7f;
    private final List<Path> body = new ArrayList<>();
    private Path ink;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint inkPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final int size;

    ToolIconView(Context context, Kind kind, int sizePx) {
        super(context);
        size = sizePx;
        for (Paint p : new Paint[]{paint, inkPaint}) {
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeCap(Paint.Cap.ROUND);
            p.setStrokeJoin(Paint.Join.ROUND);
            p.setStrokeWidth(STROKE);
        }
        switch (kind) {
            case PEN:
                ink = PathParser.createPathFromPathData("M3.5 20.5c2.2-1.6 3.6-.2 5.4-1.2 1.4-.8 2.2-.3 3.6.4");
                add("M14.8 4.7l4.5 4.5L10 18.5l-5.3.8.8-5.3z", "M12.9 6.6l4.5 4.5");
                break;
            case ERASER:
                add("M4 21h3", "M9 21h2",
                    "M8.6 18.5L3.9 13.8a1.6 1.6 0 0 1 0-2.3l7.4-7.4a1.6 1.6 0 0 1 2.3 0l5.7 5.7a1.6 1.6 0 0 1 0 2.3l-6.9 6.9z",
                    "M7.5 7.8l8.7 8.7");
                break;
            case CLEAR:
                add("M4 6.5h16", "M9.5 6.5V4.8c0-.7.5-1.3 1.2-1.3h2.6c.7 0 1.2.6 1.2 1.3v1.7",
                    "M6 6.5l.9 12.4c.1 1 .9 1.6 1.8 1.6h6.6c.9 0 1.7-.6 1.8-1.6L18 6.5",
                    "M10 10.5v6", "M14 10.5v6");
                break;
            case QUESTION:
                add("M12 3.5c4.7 0 8.5 3.2 8.5 7.3S16.7 18 12 18c-1 0-1.9-.1-2.8-.4L4.5 20l1.2-3.6C4.3 15 3.5 13 3.5 10.8 3.5 6.7 7.3 3.5 12 3.5z",
                    "M10 9.2a2 2 0 1 1 3 1.7c-.6.4-1 .8-1 1.5");
                circle(12f, 14.9f, .4f);
                break;
            case DASHBOARD:
                roundRect(3.5f, 3.5f);
                roundRect(13.5f, 3.5f);
                roundRect(3.5f, 13.5f);
                roundRect(13.5f, 13.5f);
                break;
            case REGION:
                add("M3.5 8.5v-3a2 2 0 0 1 2-2h3", "M15.5 3.5h3a2 2 0 0 1 2 2v3",
                    "M20.5 15.5v3a2 2 0 0 1-2 2h-3", "M8.5 20.5h-3a2 2 0 0 1-2-2v-3");
                break;
            case PROJECT:
                add("M3.5 15.5L12 20l8.5-4.5", "M3.5 12L12 16.5l8.5-4.5", "M12 3.5L20.5 8 12 12.5 3.5 8z");
                break;
            case STOP:
                add("M6.5 6.5l11 11", "M17.5 6.5l-11 11");
                break;
        }
    }

    private void add(String... data) {
        for (String d : data) body.add(PathParser.createPathFromPathData(d));
    }

    private void circle(float cx, float cy, float r) {
        Path p = new Path();
        p.addCircle(cx, cy, r, Path.Direction.CW);
        body.add(p);
    }

    private void roundRect(float x, float y) {
        Path p = new Path();
        p.addRoundRect(new RectF(x, y, x + 7, y + 7), 1.8f, 1.8f, Path.Direction.CW);
        body.add(p);
    }

    void setColor(int color) {
        paint.setColor(color);
        if (ink != null && inkPaint.getColor() == 0) inkPaint.setColor(color);
        invalidate();
    }

    /** Pen colour for the pen icon's line. */
    void setInk(int color) {
        inkPaint.setColor(color);
        invalidate();
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        setMeasuredDimension(size, size);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        float scale = Math.min(getWidth(), getHeight()) / UNITS;
        canvas.save();
        canvas.translate((getWidth() - UNITS * scale) / 2, (getHeight() - UNITS * scale) / 2);
        canvas.scale(scale, scale);
        if (ink != null) canvas.drawPath(ink, inkPaint);
        for (Path p : body) canvas.drawPath(p, paint);
        canvas.restore();
    }
}
