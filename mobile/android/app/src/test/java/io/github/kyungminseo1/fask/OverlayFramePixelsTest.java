package io.github.kyungminseo1.fask;

import static org.junit.Assert.*;
import io.github.kyungminseo1.fask.OverlayGeometry.PixelRect;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import org.junit.Test;

public class OverlayFramePixelsTest {
    private static final int OUTSIDE = 0xffff00ff;

    private static void rgba(ByteBuffer buffer, int offset, int argb) {
        buffer.put(offset, (byte) (argb >>> 16));
        buffer.put(offset + 1, (byte) (argb >>> 8));
        buffer.put(offset + 2, (byte) argb);
        buffer.put(offset + 3, (byte) (argb >>> 24));
    }

    @Test public void paddedRowsAndPixelGapsNeverLeakIntoSelection() {
        ByteBuffer buffer = ByteBuffer.allocate(64);
        for (int i = 0; i < buffer.limit(); i++) buffer.put(i, (byte) 0xed);
        for (int y = 0; y < 3; y++) {
            for (int x = 0; x < 3; x++) rgba(buffer, y * 24 + x * 6, OUTSIDE);
        }
        rgba(buffer, 24 + 6, 0x80123456);
        rgba(buffer, 24 + 12, 0xffabcdef);
        rgba(buffer, 48 + 6, 0x00010203);
        rgba(buffer, 48 + 12, 0xfe987654);
        // Last row padding is absent: only the final pixel's four bytes exist.
        assertArrayEquals(new int[] {0x80123456, 0xffabcdef, 0x00010203, 0xfe987654},
            OverlayFramePixels.cropRgba(buffer, 3, 3, 24, 6,
                new PixelRect(0, 0, 3, 3), new PixelRect(1, 1, 3, 3)));
    }

    @Test public void nonzeroPositionAndLimitAreRespectedWithoutMutation() {
        ByteBuffer buffer = ByteBuffer.allocateDirect(48).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < 48; i++) buffer.put(i, (byte) 0x77);
        rgba(buffer, 7, OUTSIDE);
        rgba(buffer, 11, 0x40123456);
        rgba(buffer, 23, OUTSIDE);
        rgba(buffer, 27, 0x80abcdef);
        buffer.position(7);
        buffer.mark();
        buffer.limit(31);
        buffer = buffer.asReadOnlyBuffer();
        assertArrayEquals(new int[] {0x40123456, 0x80abcdef},
            OverlayFramePixels.cropRgba(buffer, 2, 2, 16, 4,
                new PixelRect(0, 0, 2, 2), new PixelRect(1, 0, 2, 2)));
        assertEquals(7, buffer.position());
        assertEquals(31, buffer.limit());
        buffer.reset();
        assertEquals(7, buffer.position());
        assertEquals((byte) 0x77, buffer.get(6));
        assertEquals((byte) 0x77, buffer.get(22));
    }

    @Test public void croppedImageBoundsDoNotRebasePlaneOriginOrIncludeOutsideColors() {
        ByteBuffer buffer = ByteBuffer.allocate(80);
        for (int y = 0; y < 4; y++) {
            for (int x = 0; x < 5; x++) rgba(buffer, y * 20 + x * 4, OUTSIDE);
        }
        rgba(buffer, 2 * 20 + 2 * 4, 0xff112233);
        rgba(buffer, 2 * 20 + 3 * 4, 0xff445566);
        rgba(buffer, 3 * 20 + 2 * 4, 0xff778899);
        rgba(buffer, 3 * 20 + 3 * 4, 0xffaabbcc);
        assertArrayEquals(new int[] {0xff112233, 0xff445566, 0xff778899, 0xffaabbcc},
            OverlayFramePixels.cropRgba(buffer, 5, 4, 20, 4,
                new PixelRect(1, 1, 4, 4), new PixelRect(2, 2, 4, 4)));
        assertThrows(IllegalArgumentException.class, () -> OverlayFramePixels.cropRgba(
            buffer, 5, 4, 20, 4, new PixelRect(1, 1, 4, 4), new PixelRect(0, 1, 2, 2)));
        assertThrows(IllegalArgumentException.class, () -> OverlayFramePixels.cropRgba(
            buffer, 5, 4, 20, 4, new PixelRect(1, 1, 4, 4), new PixelRect(3, 3, 5, 4)));
    }

    @Test public void sourceByteOrderDoesNotChangeArgbChannels() {
        ByteBuffer buffer = ByteBuffer.allocate(4);
        rgba(buffer, 0, 0x81234567);
        PixelRect one = new PixelRect(0, 0, 1, 1);
        for (ByteOrder order : new ByteOrder[] {ByteOrder.BIG_ENDIAN, ByteOrder.LITTLE_ENDIAN}) {
            buffer.order(order);
            assertArrayEquals(new int[] {0x81234567},
                OverlayFramePixels.cropRgba(buffer, 1, 1, 4, 4, one, one));
        }
    }

    @Test public void sourceLimitNotCapacityDeterminesReadablePixels() {
        ByteBuffer buffer = ByteBuffer.allocate(32);
        buffer.position(5);
        buffer.limit(12);
        PixelRect bounds = new PixelRect(0, 0, 2, 1);
        assertThrows(IllegalArgumentException.class, () -> OverlayFramePixels.cropRgba(
            buffer, 2, 1, 8, 4, bounds, new PixelRect(1, 0, 2, 1)));
        assertEquals(5, buffer.position());
        assertEquals(12, buffer.limit());
    }

    @Test public void selectedPixelsNeedNotReadUnselectedLaterRows() {
        ByteBuffer buffer = ByteBuffer.allocate(4);
        rgba(buffer, 0, 0xff102030);
        assertArrayEquals(new int[] {0xff102030}, OverlayFramePixels.cropRgba(
            buffer, 2, 2, 8, 4, new PixelRect(0, 0, 2, 2), new PixelRect(0, 0, 1, 1)));
    }

    @Test public void invalidImageBoundsAndOverlappingRowsAreRejected() {
        ByteBuffer buffer = ByteBuffer.allocate(32);
        PixelRect two = new PixelRect(0, 0, 2, 2);
        assertThrows(IllegalArgumentException.class, () -> OverlayFramePixels.cropRgba(
            buffer, 0, 2, 8, 4, two, two));
        assertThrows(IllegalArgumentException.class, () -> OverlayFramePixels.cropRgba(
            buffer, 2, 2, 8, 3, two, two));
        assertThrows(IllegalArgumentException.class, () -> OverlayFramePixels.cropRgba(
            buffer, 2, 2, 7, 4, two, two));
        assertThrows(IllegalArgumentException.class, () -> OverlayFramePixels.cropRgba(
            buffer, 2, 2, -8, 4, two, two));
        assertThrows(IllegalArgumentException.class, () -> OverlayFramePixels.cropRgba(
            buffer, 2, 2, 8, 4, new PixelRect(-1, 0, 2, 2), two));
        assertThrows(IllegalArgumentException.class, () -> OverlayFramePixels.cropRgba(
            buffer, 2, 2, 8, 4, new PixelRect(0, 0, 3, 2), two));
    }

    @Test public void hugeDimensionsAndOffsetsRejectWithoutOverflowOrAllocation() {
        ByteBuffer buffer = ByteBuffer.allocate(4);
        PixelRect one = new PixelRect(0, 0, 1, 1);
        assertThrows(IllegalArgumentException.class, () -> OverlayFramePixels.cropRgba(
            buffer, Integer.MAX_VALUE, 1, Integer.MAX_VALUE, 4, one, one));
        PixelRect tall = new PixelRect(0, 0, 1, Integer.MAX_VALUE);
        assertThrows(IllegalArgumentException.class, () -> OverlayFramePixels.cropRgba(
            buffer, 1, Integer.MAX_VALUE, Integer.MAX_VALUE, 4, tall,
            new PixelRect(0, Integer.MAX_VALUE - 1, 1, Integer.MAX_VALUE)));
        PixelRect excessive = new PixelRect(0, 0, 1, OverlayFramePixels.MAX_PIXELS + 1);
        assertThrows(IllegalArgumentException.class, () -> OverlayFramePixels.cropRgba(
            buffer, 1, OverlayFramePixels.MAX_PIXELS + 1, 4, 4, excessive, excessive));
    }
}
