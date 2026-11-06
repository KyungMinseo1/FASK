package io.github.kyungminseo1.fask;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.os.Build;
import android.view.View;

/**
 * The overlay toggle: the short logo mark "f." (desktop MarkF) with a drag grip under it,
 * drawn inside an optional tile inset. The period takes the pen colour while drawing and the
 * theme logo accent otherwise. When joined to the toolbar it draws the separator on that side.
 */
final class ToggleMarkView extends View {
    enum Side { NONE, TOP, BOTTOM, LEFT, RIGHT }

    private static final float TRACKING = -0.06f;
    private final Paint text = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.SUBPIXEL_TEXT_FLAG);
    private final Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Rect glyphs = new Rect();
    private final RectF bar = new RectF();
    private float density;
    private int ink, dot, markAlpha = 255;
    private int insetX, insetY;
    private float sizeDp = 24;
    private Side separator = Side.NONE;

    ToggleMarkView(Context context, float density) {
        super(context);
        this.density = density;
        text.setTypeface(Build.VERSION.SDK_INT >= 28 ? Typeface.create(Typeface.DEFAULT, 800, false) : Typeface.DEFAULT_BOLD);
    }

    private float dp(float v) { return v * density; }

    void setDensity(float density) {
        if (this.density == density) return;
        this.density = density;
        invalidate();
    }

    void setColors(int ink, int dot) {
        if (this.ink == ink && this.dot == dot) return;
        this.ink = ink; this.dot = dot;
        invalidate();
    }

    /** Attention blink: fades the mark only; the view alpha belongs to the collapse logic. */
    void setMarkAlpha(int alpha) {
        if (markAlpha == alpha) return;
        markAlpha = alpha;
        invalidate();
    }

    /** Collapsed: a smaller mark in a tile inset from the touch area. */
    void setShape(int insetX, int insetY, float sizeDp, Side separator) {
        this.insetX = insetX; this.insetY = insetY; this.sizeDp = sizeDp; this.separator = separator;
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        float l = insetX, t = insetY, r = getWidth() - insetX, b = getHeight() - insetY;
        if (r <= l || b <= t) return;
        float size = dp(sizeDp);
        text.setTextSize(size);
        float fw = text.measureText("f"), pw = text.measureText(".");
        float kern = TRACKING * size;
        float cx = (l + r) / 2f, cy = (t + b) / 2f - dp(2);
        text.getTextBounds("f.", 0, 2, glyphs);
        float x = cx - (fw + kern + pw) / 2f;
        float baseline = cy - glyphs.exactCenterY();
        text.setColor(withAlpha(ink, markAlpha));
        canvas.drawText("f", x, baseline, text);
        text.setColor(withAlpha(dot, markAlpha));
        canvas.drawText(".", x + fw + kern, baseline, text);

        // Grip: 16x2, 25% ink, 6dp above the tile bottom (desktop .toolbar-grip).
        line.setColor(withAlpha(ink, 64));
        float gy = b - dp(6);
        bar.set(cx - dp(8), gy - dp(2), cx + dp(8), gy);
        canvas.drawRoundRect(bar, dp(1), dp(1), line);

        if (separator == Side.NONE) return;
        line.setColor(withAlpha(ink, 36));
        float w = dp(1), m = dp(6);
        switch (separator) {
            case BOTTOM: canvas.drawRect(l + m, b - w, r - m, b, line); break;
            case TOP: canvas.drawRect(l + m, t, r - m, t + w, line); break;
            case LEFT: canvas.drawRect(l, t + m, l + w, b - m, line); break;
            case RIGHT: canvas.drawRect(r - w, t + m, r, b - m, line); break;
            default: break;
        }
    }

    private static int withAlpha(int color, int alpha) {
        return (Math.round((color >>> 24) * alpha / 255f) << 24) | (color & 0x00FFFFFF);
    }
}
