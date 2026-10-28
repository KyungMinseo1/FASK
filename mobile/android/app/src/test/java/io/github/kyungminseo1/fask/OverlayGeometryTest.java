package io.github.kyungminseo1.fask;

import static org.junit.Assert.*;
import io.github.kyungminseo1.fask.OverlayGeometry.GeometrySnapshot;
import io.github.kyungminseo1.fask.OverlayGeometry.PixelRect;
import io.github.kyungminseo1.fask.OverlayGeometry.PointPx;
import io.github.kyungminseo1.fask.OverlayGeometry.RegionRect;
import io.github.kyungminseo1.fask.OverlayGeometry.SizePx;
import org.junit.Test;

/** Pure primitive geometry: no Android Rect/Point/Size or mockable android.jar behavior. */
public class OverlayGeometryTest {
    private static final double EPSILON = 0.000001;

    private static GeometrySnapshot initial() {
        return OverlayGeometry.snapshotAfter(null, 0, 0, new PixelRect(0, 0, 1200, 1920),
            new PointPx(0, 48), new SizePx(1200, 1872), 320, 1);
    }

    private static GeometrySnapshot changed(GeometrySnapshot old, int displayId, int rotation,
                                            PixelRect bounds, PointPx origin, SizePx size,
                                            int density, long generation) {
        return OverlayGeometry.snapshotAfter(old, displayId, rotation, bounds, origin, size,
            density, generation);
    }

    @Test public void measuredViewOriginIsAppliedExactlyOnceBeforeCropTranslation() {
        GeometrySnapshot geometry = initial();
        PointPx displayPoint = OverlayGeometry.localToDisplay(geometry, 100, 200);
        assertEquals(100, displayPoint.x, EPSILON);
        assertEquals(248, displayPoint.y, EPSILON);
        PixelRect crop = OverlayGeometry.crop(geometry, geometry.epoch,
            new RegionRect(80, 200, 380, 500));
        PointPx result = OverlayGeometry.cropLocalPoint(displayPoint, crop);
        assertEquals(20, result.x, EPSILON);
        assertEquals(48, result.y, EPSILON);
        assertEquals(300, crop.width());
        assertEquals(300, crop.height());
    }

    @Test public void screenOriginIsRemovedButInsetsAreNotSubtractedAgain() {
        GeometrySnapshot geometry = new GeometrySnapshot(1, 0, 0,
            new PixelRect(30, 60, 1230, 1980), new PointPx(30, 108),
            new SizePx(1200, 1872), 320, 1);
        PointPx result = OverlayGeometry.localToDisplay(geometry, 100, 200);
        assertEquals(100, result.x, EPSILON);
        assertEquals(248, result.y, EPSILON);
        PixelRect crop = OverlayGeometry.crop(geometry, geometry.epoch,
            new RegionRect(-10.2, -12.4, 1205.1, 1930.6));
        assertEquals(new PixelRect(0, 0, 1200, 1920), crop);
    }

    @Test public void fractionalCropRoundsOutwardToIncludeEverySelectedPixel() {
        GeometrySnapshot geometry = initial();
        PixelRect crop = OverlayGeometry.crop(geometry, geometry.epoch,
            new RegionRect(80.8, 200.2, 379.1, 499.9));
        assertEquals(new PixelRect(80, 200, 380, 500), crop);
        PixelRect subpixel = OverlayGeometry.crop(geometry, geometry.epoch,
            new RegionRect(100.1, 200.1, 100.2, 200.2));
        assertEquals(new PixelRect(100, 200, 101, 201), subpixel);
    }

    @Test public void partiallyOutsideCropClampsToDisplayNotMeasuredInkSize() {
        GeometrySnapshot geometry = initial();
        PixelRect crop = OverlayGeometry.crop(geometry, geometry.epoch,
            new RegionRect(1190.2, 1890.7, 1300, 2000));
        assertEquals(new PixelRect(1190, 1890, 1200, 1920), crop);
    }

    @Test public void emptyOrWhollyOutsideSelectionCannotBecomeFullDisplayFallback() {
        GeometrySnapshot geometry = initial();
        assertThrows(IllegalArgumentException.class, () -> OverlayGeometry.crop(geometry,
            geometry.epoch, new RegionRect(100, 200, 100, 250)));
        assertThrows(IllegalArgumentException.class, () -> OverlayGeometry.crop(geometry,
            geometry.epoch, new RegionRect(-10, 20, 0, 30)));
        assertThrows(IllegalArgumentException.class, () -> OverlayGeometry.crop(geometry,
            geometry.epoch, new RegionRect(1200, 20, 1250, 30)));
        assertThrows(IllegalArgumentException.class, () -> OverlayGeometry.crop(geometry,
            geometry.epoch, new RegionRect(20, 1920, 30, 1950)));
    }

    @Test public void regionClampEnforcesMinimumAndKeepsMovedSelectionInsideDisplay() {
        GeometrySnapshot geometry = initial();
        RegionRect small = OverlayGeometry.clampRegion(geometry,
            new RegionRect(1195, 1910, 1198, 1915), 48, 48);
        assertEquals(1152, small.left, EPSILON);
        assertEquals(1872, small.top, EPSILON);
        assertEquals(1200, small.right, EPSILON);
        assertEquals(1920, small.bottom, EPSILON);
        RegionRect moved = OverlayGeometry.clampRegion(geometry,
            new RegionRect(-50, -80, 250, 220), 48, 48);
        assertEquals(0, moved.left, EPSILON);
        assertEquals(0, moved.top, EPSILON);
        assertEquals(300, moved.width(), EPSILON);
        assertEquals(300, moved.height(), EPSILON);
    }

    @Test public void displaySmallerThanMinimumNeverCreatesOutsideRegion() {
        GeometrySnapshot geometry = new GeometrySnapshot(1, 0, 0,
            new PixelRect(0, 0, 20, 30), new PointPx(0, 0), new SizePx(20, 30), 160, 1);
        RegionRect region = OverlayGeometry.clampRegion(geometry,
            new RegionRect(5, 6, 10, 12), 24, 24);
        assertEquals(0, region.left, EPSILON);
        assertEquals(6, region.top, EPSILON);
        assertEquals(20, region.width(), EPSILON);
        assertEquals(24, region.height(), EPSILON);
    }

    @Test public void identicalMeasurementsPreserveEpochAndSnapshotIdentity() {
        GeometrySnapshot old = initial();
        assertSame(old, changed(old, 0, 0, new PixelRect(0, 0, 1200, 1920),
            new PointPx(0, 48), new SizePx(1200, 1872), 320, 1));
    }

    @Test public void halfTurnInvalidatesDespiteIdenticalDisplayAndReaderDimensions() {
        GeometrySnapshot old = initial();
        GeometrySnapshot rotated = changed(old, old.displayId, 2, old.displayBoundsPx,
            old.inkOriginPx, old.inkSizePx, old.densityDpi, old.readerGeneration);
        assertEquals(old.epoch + 1, rotated.epoch);
        assertEquals(old.displayBoundsPx, rotated.displayBoundsPx);
        assertThrows(IllegalStateException.class, () -> OverlayGeometry.crop(rotated, old.epoch,
            new RegionRect(80, 200, 380, 500)));
    }

    @Test public void sameSizedReaderReplacementInvalidatesOldRegionAndFrame() {
        GeometrySnapshot old = initial();
        GeometrySnapshot replacement = changed(old, old.displayId, old.rotation, old.displayBoundsPx,
            old.inkOriginPx, old.inkSizePx, old.densityDpi, old.readerGeneration + 1);
        assertEquals(old.epoch + 1, replacement.epoch);
        assertFalse(OverlayGeometry.matchesReader(replacement, old.epoch, old.readerGeneration,
            1200, 1920));
        assertFalse(OverlayGeometry.matchesReader(replacement, replacement.epoch,
            old.readerGeneration, 1200, 1920));
        assertThrows(IllegalStateException.class, () -> OverlayGeometry.crop(replacement, old.epoch,
            new RegionRect(80, 200, 380, 500)));
        assertTrue(OverlayGeometry.matchesReader(replacement, replacement.epoch,
            replacement.readerGeneration, 1200, 1920));
    }

    @Test public void everyCoordinateContractFieldChangeAdvancesEpoch() {
        GeometrySnapshot old = initial();
        GeometrySnapshot[] changes = {
            changed(old, 1, 0, old.displayBoundsPx, old.inkOriginPx, old.inkSizePx, 320, 1),
            changed(old, 0, 0, new PixelRect(0, 0, 1920, 1200), old.inkOriginPx,
                old.inkSizePx, 320, 1),
            changed(old, 0, 0, new PixelRect(10, 20, 1210, 1940), old.inkOriginPx,
                old.inkSizePx, 320, 1),
            changed(old, 0, 0, old.displayBoundsPx, new PointPx(0, 49), old.inkSizePx, 320, 1),
            changed(old, 0, 0, old.displayBoundsPx, old.inkOriginPx, new SizePx(1200, 1871), 320, 1),
            changed(old, 0, 0, old.displayBoundsPx, old.inkOriginPx, old.inkSizePx, 321, 1)
        };
        for (GeometrySnapshot change : changes) assertEquals(old.epoch + 1, change.epoch);
        // A delayed old callback must not mutate the immutable snapshot used by pending work.
        assertEquals(1, old.epoch);
        assertEquals(48, old.inkOriginPx.y, EPSILON);
        assertEquals(1920, old.displayBoundsPx.height());
    }

    @Test public void capturedContentChangeCanInvalidateWithoutInventingScaleOrOffset() {
        GeometrySnapshot old = initial();
        GeometrySnapshot invalid = OverlayGeometry.invalidate(old);
        assertEquals(old.epoch + 1, invalid.epoch);
        assertSame(old.displayBoundsPx, invalid.displayBoundsPx);
        assertSame(old.inkOriginPx, invalid.inkOriginPx);
        assertFalse(OverlayGeometry.matchesReader(invalid, old.epoch, old.readerGeneration,
            1200, 1920));
    }

    @Test public void readerMustMatchValidPixelDimensionsNotPaddingOrScaledContent() {
        GeometrySnapshot geometry = initial();
        assertTrue(OverlayGeometry.matchesReader(geometry, geometry.epoch, 1, 1200, 1920));
        assertFalse(OverlayGeometry.matchesReader(geometry, geometry.epoch, 1, 1216, 1920));
        assertFalse(OverlayGeometry.matchesReader(geometry, geometry.epoch, 1, 600, 960));
        assertFalse(OverlayGeometry.matchesReader(geometry, geometry.epoch, 1, 1920, 1200));
    }

    @Test public void translatingOutsideStrokeDoesNotClampItOntoCropEdge() {
        PixelRect crop = new PixelRect(80, 200, 380, 500);
        PointPx outside = OverlayGeometry.cropLocalPoint(new PointPx(40, 180), crop);
        assertEquals(-40, outside.x, EPSILON);
        assertEquals(-20, outside.y, EPSILON);
        PointPx bottomRight = OverlayGeometry.cropLocalPoint(new PointPx(380, 500), crop);
        assertEquals(crop.width(), bottomRight.x, EPSILON);
        assertEquals(crop.height(), bottomRight.y, EPSILON);
    }

    @Test public void invalidCoordinatesAndOverflowingBoundsAreRejected() {
        assertThrows(IllegalArgumentException.class, () -> new PointPx(Double.NaN, 0));
        assertThrows(IllegalArgumentException.class, () -> new PointPx(0, Double.POSITIVE_INFINITY));
        assertThrows(IllegalArgumentException.class, () -> new RegionRect(0, 0, Double.NaN, 1));
        assertThrows(IllegalArgumentException.class, () -> new RegionRect(2, 0, 1, 1));
        assertThrows(IllegalArgumentException.class,
            () -> new PixelRect(Integer.MIN_VALUE, 0, Integer.MAX_VALUE, 1));
        assertThrows(IllegalArgumentException.class, () -> new SizePx(0, 100));
    }
}
