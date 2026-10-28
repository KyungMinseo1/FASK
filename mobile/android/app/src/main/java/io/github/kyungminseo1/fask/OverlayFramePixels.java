package io.github.kyungminseo1.fask;

import io.github.kyungminseo1.fask.OverlayGeometry.PixelRect;
import java.nio.ByteBuffer;
import java.util.Objects;

/** RGBA_8888 plane extraction without Android dependencies or a full-frame intermediate. */
public final class OverlayFramePixels {
    public static final int MAX_PIXELS = 25_000_000;

    private OverlayFramePixels() {}

    /**
     * Returns tightly packed ARGB pixels, row-major, for exactly {@code selection}.
     * The buffer's current position is the address of image pixel (0, 0), not the
     * Image crop origin. Both rectangles use the original image's coordinates;
     * an Image crop restricts valid pixels but does not rebase its plane buffer.
     * Strides are bytes. RGBA channels are read individually, independent of byte order.
     * Only selected bytes must be available up to the buffer limit: trailing row
     * padding (including after the last pixel) need not be present. Position, limit,
     * mark and contents of the source are unchanged. The caller retains ownership.
     */
    public static int[] cropRgba(ByteBuffer buffer, int width, int height,
                                 int rowStride, int pixelStride,
                                 PixelRect imageCrop, PixelRect selection) {
        Objects.requireNonNull(buffer, "buffer");
        Objects.requireNonNull(imageCrop, "imageCrop");
        Objects.requireNonNull(selection, "selection");
        if (width <= 0 || height <= 0 || pixelStride < 4 || rowStride <= 0
            || (long) (width - 1) * pixelStride + 4 > rowStride) {
            throw new IllegalArgumentException("Invalid RGBA image dimensions or strides");
        }
        if (imageCrop.left < 0 || imageCrop.top < 0
            || imageCrop.right > width || imageCrop.bottom > height
            || selection.left < imageCrop.left || selection.top < imageCrop.top
            || selection.right > imageCrop.right || selection.bottom > imageCrop.bottom) {
            throw new IllegalArgumentException("Selection must be contained in the image crop");
        }
        long count = (long) selection.width() * selection.height();
        long end = buffer.position() + (long) (selection.bottom - 1) * rowStride
            + (long) (selection.right - 1) * pixelStride + 4;
        if (count > MAX_PIXELS || end > buffer.limit()) {
            throw new IllegalArgumentException("Selected pixels exceed buffer or output bounds");
        }

        int[] pixels = new int[(int) count];
        int output = 0;
        for (int y = selection.top; y < selection.bottom; y++) {
            long row = buffer.position() + (long) y * rowStride;
            for (int x = selection.left; x < selection.right; x++) {
                int offset = (int) (row + (long) x * pixelStride);
                int red = buffer.get(offset) & 0xff;
                int green = buffer.get(offset + 1) & 0xff;
                int blue = buffer.get(offset + 2) & 0xff;
                int alpha = buffer.get(offset + 3) & 0xff;
                pixels[output++] = (alpha << 24) | (red << 16) | (green << 8) | blue;
            }
        }
        return pixels;
    }
}
