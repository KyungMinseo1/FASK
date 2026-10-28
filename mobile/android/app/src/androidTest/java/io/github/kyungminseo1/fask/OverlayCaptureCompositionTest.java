package io.github.kyungminseo1.fask;

import static org.junit.Assert.*;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.os.SystemClock;
import android.util.Base64;
import android.view.MotionEvent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class OverlayCaptureCompositionTest {
    @Test public void paddedFrameCropsBeforeSingleInkCompositionWithMeasuredOrigin() {
        int width = 1200, height = 1920, rowStride = width * 4 + 16, position = 7;
        ByteBuffer frame = ByteBuffer.allocate(position + rowStride * height);
        frame.position(position);
        // The IN crop is white; everything outside it, including padding, is blue.
        for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
            int offset = position + y * rowStride + x * 4;
            boolean inside = x >= 80 && x < 380 && y >= 200 && y < 500;
            frame.put(offset, (byte) (inside ? 255 : 0));
            frame.put(offset + 1, (byte) (inside ? 255 : 0));
            frame.put(offset + 2, (byte) 255);
            frame.put(offset + 3, (byte) 255);
        }
        OverlayGeometry.PixelRect crop = new OverlayGeometry.PixelRect(80, 200, 380, 500);
        int[] pixels = OverlayFramePixels.cropRgba(frame, width, height, rowStride, 4,
            new OverlayGeometry.PixelRect(0, 0, width, height), crop);
        AtomicReference<List<OverlayInkView.Stroke>> frozen = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            OverlayInkView ink = ink(width, height, 0, 48);
            stroke(ink, 100, 200, 100, 200); // screen=(100,248), crop=(20,48)
            stroke(ink, 600, 200, 700, 200); // outside crop, must never leak into output
            frozen.set(ink.snapshotStrokes());
            ink.clearInk(); // a later edit cannot mutate a previously frozen Path
        });
        Bitmap bitmap = OverlayCaptureController.compose(pixels, crop, frozen.get());
        try {
            assertEquals(300, bitmap.getWidth());
            assertEquals(300, bitmap.getHeight());
            assertEquals(0xffef4444, bitmap.getPixel(20, 48));
            assertEquals(Color.WHITE, bitmap.getPixel(20, 0)); // no double subtraction of status inset
            assertEquals(Color.WHITE, bitmap.getPixel(20, 96)); // no second view-origin offset
            for (int y = 0; y < bitmap.getHeight(); y++) for (int x = 0; x < bitmap.getWidth(); x++) {
                assertNotEquals("OUT/background padding leaked into crop", Color.BLUE, bitmap.getPixel(x, y));
            }
        } finally { bitmap.recycle(); }
        assertEquals(position, frame.position());
    }

    @Test public void cropClipsStrokeAtBothEdgesWithoutMovingIt() {
        AtomicReference<List<OverlayInkView.Stroke>> strokes = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            OverlayInkView ink = ink(1200, 1920, 0, 48);
            stroke(ink, 50, 300, 450, 300);
            strokes.set(ink.snapshotStrokes());
        });
        OverlayGeometry.PixelRect crop = new OverlayGeometry.PixelRect(80, 200, 380, 500);
        int[] pixels = new int[300 * 300]; Arrays.fill(pixels, Color.WHITE);
        Bitmap bitmap = OverlayCaptureController.compose(pixels, crop, strokes.get());
        try {
            assertEquals(0xffef4444, bitmap.getPixel(0, 148));
            assertEquals(0xffef4444, bitmap.getPixel(299, 148));
            assertEquals(Color.WHITE, bitmap.getPixel(0, 143));
            assertEquals(Color.WHITE, bitmap.getPixel(299, 153));
        } finally { bitmap.recycle(); }
    }

    @Test public void jpegScalesTheAlreadyCompositedCropOnlyOnce() {
        OverlayGeometry.PixelRect crop = new OverlayGeometry.PixelRect(0, 0, 4096, 1024);
        int[] pixels = new int[4096 * 1024]; Arrays.fill(pixels, Color.WHITE);
        for (int y = 256; y < 768; y++) Arrays.fill(pixels, y * 4096 + 1536, y * 4096 + 2560, Color.RED);
        Bitmap original = OverlayCaptureController.compose(pixels, crop, Collections.emptyList());
        Bitmap decoded = null;
        try {
            String result = OverlayCaptureController.encode(original);
            assertTrue(result.startsWith("data:image/jpeg;base64,"));
            byte[] jpeg = Base64.decode(result.substring(result.indexOf(',') + 1), Base64.NO_WRAP);
            assertTrue(jpeg.length <= OverlayCaptureController.MAX_IMAGE_BYTES);
            assertEquals(0xff, jpeg[0] & 255); assertEquals(0xd8, jpeg[1] & 255);
            decoded = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
            assertNotNull(decoded);
            assertEquals(2048, decoded.getWidth()); assertEquals(512, decoded.getHeight());
            int red = decoded.getPixel(1024, 256);
            assertTrue(Color.red(red) > 245 && Color.green(red) < 10 && Color.blue(red) < 10);
            assertEquals(Color.WHITE, decoded.getPixel(100, 100));
        } finally { original.recycle(); if (decoded != null) decoded.recycle(); }
    }

    private static OverlayInkView ink(int width, int height, int originX, int originY) {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        OverlayInkView ink = new OverlayInkView(context, new OverlayInkView.Listener() {
            @Override public void onRevisionChanged() {}
            @Override public void onRegionConfirmed() {}
            @Override public void onRegionCancelled() {}
            @Override public void onGeometryMeasured(int x, int y, int w, int h) {}
        });
        ink.setGeometry(new OverlayGeometry.GeometrySnapshot(1, 0, 0,
            new OverlayGeometry.PixelRect(0, 0, width, height), new OverlayGeometry.PointPx(originX, originY),
            new OverlayGeometry.SizePx(width, height - originY), 160, 1));
        ink.setMode(OverlayWindowController.Mode.PEN);
        return ink;
    }
    private static void stroke(OverlayInkView ink, float x1, float y1, float x2, float y2) {
        long time = SystemClock.uptimeMillis();
        event(ink, time, MotionEvent.ACTION_DOWN, x1, y1);
        if (x1 != x2 || y1 != y2) event(ink, time + 1, MotionEvent.ACTION_MOVE, x2, y2);
        event(ink, time + 2, MotionEvent.ACTION_UP, x2, y2);
    }
    private static void event(OverlayInkView ink, long time, int action, float x, float y) {
        MotionEvent.PointerProperties property = new MotionEvent.PointerProperties();
        property.id = 0; property.toolType = MotionEvent.TOOL_TYPE_STYLUS;
        MotionEvent.PointerCoords point = new MotionEvent.PointerCoords(); point.x = x; point.y = y; point.pressure = 1;
        MotionEvent event = MotionEvent.obtain(time, time, action, 1, new MotionEvent.PointerProperties[]{property},
            new MotionEvent.PointerCoords[]{point}, 0, 0, 1, 1, 0, 0, android.view.InputDevice.SOURCE_STYLUS, 0);
        try { ink.onTouchEvent(event); } finally { event.recycle(); }
    }
}
