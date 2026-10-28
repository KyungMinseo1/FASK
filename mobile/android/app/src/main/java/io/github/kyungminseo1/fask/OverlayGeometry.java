package io.github.kyungminseo1.fask;

import java.util.Objects;

/** Display-local pixel geometry. Android window measurements are adapted at the call site. */
public final class OverlayGeometry {
    private OverlayGeometry() {}

    public static final class PixelRect {
        public final int left;
        public final int top;
        public final int right;
        public final int bottom;

        public PixelRect(int left, int top, int right, int bottom) {
            if (right <= left || bottom <= top
                || (long) right - left > Integer.MAX_VALUE
                || (long) bottom - top > Integer.MAX_VALUE) {
                throw new IllegalArgumentException("Pixel bounds must have positive dimensions");
            }
            this.left = left;
            this.top = top;
            this.right = right;
            this.bottom = bottom;
        }

        public int width() { return right - left; }
        public int height() { return bottom - top; }

        @Override public boolean equals(Object other) {
            if (!(other instanceof PixelRect)) return false;
            PixelRect rect = (PixelRect) other;
            return left == rect.left && top == rect.top && right == rect.right && bottom == rect.bottom;
        }

        @Override public int hashCode() {
            return ((31 * left + top) * 31 + right) * 31 + bottom;
        }
    }

    public static final class PointPx {
        public final double x;
        public final double y;

        public PointPx(double x, double y) {
            requireFinite(x);
            requireFinite(y);
            this.x = x;
            this.y = y;
        }

        @Override public boolean equals(Object other) {
            if (!(other instanceof PointPx)) return false;
            PointPx point = (PointPx) other;
            return Double.compare(x, point.x) == 0 && Double.compare(y, point.y) == 0;
        }

        @Override public int hashCode() {
            return 31 * Double.hashCode(x) + Double.hashCode(y);
        }
    }

    public static final class SizePx {
        public final int width;
        public final int height;

        public SizePx(int width, int height) {
            if (width <= 0 || height <= 0) throw new IllegalArgumentException("Size must be positive");
            this.width = width;
            this.height = height;
        }

        @Override public boolean equals(Object other) {
            if (!(other instanceof SizePx)) return false;
            SizePx size = (SizePx) other;
            return width == size.width && height == size.height;
        }

        @Override public int hashCode() { return 31 * width + height; }
    }

    /** A fractional selection, never a normalized or screen-origin rectangle. */
    public static final class RegionRect {
        public final double left;
        public final double top;
        public final double right;
        public final double bottom;

        public RegionRect(double left, double top, double right, double bottom) {
            requireFinite(left);
            requireFinite(top);
            requireFinite(right);
            requireFinite(bottom);
            if (right < left || bottom < top
                || !Double.isFinite(right - left) || !Double.isFinite(bottom - top)) {
                throw new IllegalArgumentException("Selection bounds must be ordered");
            }
            this.left = left;
            this.top = top;
            this.right = right;
            this.bottom = bottom;
        }

        public double width() { return right - left; }
        public double height() { return bottom - top; }
    }

    /**
     * Immutable coordinate contract for one measured ink layout and reader generation.
     * Bounds and ink origin are screen coordinates; ink points and selections are display-local.
     * Rotation is the Display rotation value, not a transform to apply to stored points.
     */
    public static final class GeometrySnapshot {
        public final long epoch;
        public final int displayId;
        public final int rotation;
        public final PixelRect displayBoundsPx;
        public final PointPx inkOriginPx;
        public final SizePx inkSizePx;
        public final int densityDpi;
        public final long readerGeneration;

        public GeometrySnapshot(long epoch, int displayId, int rotation, PixelRect displayBoundsPx,
                                PointPx inkOriginPx, SizePx inkSizePx, int densityDpi,
                                long readerGeneration) {
            if (epoch < 1 || densityDpi <= 0 || readerGeneration < 0) {
                throw new IllegalArgumentException("Invalid geometry version or density");
            }
            this.epoch = epoch;
            this.displayId = displayId;
            this.rotation = rotation;
            this.displayBoundsPx = Objects.requireNonNull(displayBoundsPx);
            this.inkOriginPx = Objects.requireNonNull(inkOriginPx);
            this.inkSizePx = Objects.requireNonNull(inkSizePx);
            this.densityDpi = densityDpi;
            this.readerGeneration = readerGeneration;
        }
    }

    /** Equal measurements retain identity; every coordinate/provenance change invalidates old ink. */
    public static GeometrySnapshot snapshotAfter(GeometrySnapshot previous, int displayId, int rotation,
                                                PixelRect displayBoundsPx, PointPx inkOriginPx,
                                                SizePx inkSizePx, int densityDpi,
                                                long readerGeneration) {
        if (previous != null && previous.displayId == displayId && previous.rotation == rotation
            && previous.displayBoundsPx.equals(displayBoundsPx)
            && previous.inkOriginPx.equals(inkOriginPx) && previous.inkSizePx.equals(inkSizePx)
            && previous.densityDpi == densityDpi && previous.readerGeneration == readerGeneration) {
            return previous;
        }
        return new GeometrySnapshot(previous == null ? 1 : Math.incrementExact(previous.epoch),
            displayId, rotation, displayBoundsPx, inkOriginPx, inkSizePx, densityDpi, readerGeneration);
    }

    /** For captured-content changes which do not change one of the measured snapshot fields. */
    public static GeometrySnapshot invalidate(GeometrySnapshot previous) {
        return new GeometrySnapshot(Math.incrementExact(previous.epoch), previous.displayId,
            previous.rotation, previous.displayBoundsPx, previous.inkOriginPx, previous.inkSizePx,
            previous.densityDpi, previous.readerGeneration);
    }

    /** No status/navigation/cutout inset subtraction: the measured screen origin already includes it. */
    public static PointPx localToDisplay(GeometrySnapshot geometry, double localX, double localY) {
        return new PointPx(localX + geometry.inkOriginPx.x - geometry.displayBoundsPx.left,
            localY + geometry.inkOriginPx.y - geometry.displayBoundsPx.top);
    }

    /** Minimum dimensions are already pixels (dp conversion is the window/controller's responsibility). */
    public static RegionRect clampRegion(GeometrySnapshot geometry, RegionRect rect,
                                         double minWidthPx, double minHeightPx) {
        requireFinite(minWidthPx);
        requireFinite(minHeightPx);
        if (minWidthPx <= 0 || minHeightPx <= 0) {
            throw new IllegalArgumentException("Minimum selection size must be positive");
        }
        double displayWidth = geometry.displayBoundsPx.width();
        double displayHeight = geometry.displayBoundsPx.height();
        double width = Math.min(displayWidth, Math.max(minWidthPx, rect.width()));
        double height = Math.min(displayHeight, Math.max(minHeightPx, rect.height()));
        double left = clamp(rect.left, 0, displayWidth - width);
        double top = clamp(rect.top, 0, displayHeight - height);
        return new RegionRect(left, top, left + width, top + height);
    }

    /**
     * Produces a half-open display-local crop, never a full-display fallback.
     * Intersect before rounding so a selection with no visible area cannot become a pixel crop.
     */
    public static PixelRect crop(GeometrySnapshot geometry, long regionEpoch, RegionRect region) {
        if (geometry.epoch != regionEpoch) throw new IllegalStateException("Selection geometry is stale");
        double left = clamp(region.left, 0, geometry.displayBoundsPx.width());
        double top = clamp(region.top, 0, geometry.displayBoundsPx.height());
        double right = clamp(region.right, 0, geometry.displayBoundsPx.width());
        double bottom = clamp(region.bottom, 0, geometry.displayBoundsPx.height());
        if (right <= left || bottom <= top) throw new IllegalArgumentException("Selection is empty");
        return new PixelRect((int) Math.floor(left), (int) Math.floor(top),
            (int) Math.ceil(right), (int) Math.ceil(bottom));
    }

    /** The only translation for compositing a stored display-local point into a selected crop. */
    public static PointPx cropLocalPoint(PointPx displayLocalPoint, PixelRect crop) {
        return new PointPx(displayLocalPoint.x - crop.left, displayLocalPoint.y - crop.top);
    }

    /** Row padding is not part of reader width. Matching size alone does not prove OEM provenance. */
    public static boolean matchesReader(GeometrySnapshot geometry, long expectedEpoch,
                                        long readerGeneration, int width, int height) {
        return geometry.epoch == expectedEpoch && geometry.readerGeneration == readerGeneration
            && geometry.displayBoundsPx.width() == width && geometry.displayBoundsPx.height() == height;
    }

    private static double clamp(double value, double low, double high) {
        return Math.max(low, Math.min(high, value));
    }

    private static void requireFinite(double value) {
        if (!Double.isFinite(value)) throw new IllegalArgumentException("Coordinate must be finite");
    }
}
