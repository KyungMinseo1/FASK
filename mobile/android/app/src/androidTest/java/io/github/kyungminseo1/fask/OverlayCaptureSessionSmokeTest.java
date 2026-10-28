package io.github.kyungminseo1.fask;

import static org.junit.Assert.*;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Bundle;
import android.util.Base64;
import androidx.core.content.ContextCompat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Opt-in real projection tests. Start instrumentation first, then consent/select in the app. */
@RunWith(AndroidJUnit4.class)
public final class OverlayCaptureSessionSmokeTest {
    private static final String CAPTURE_NOW = "io.github.kyungminseo1.fask.test.CAPTURE_NOW";

    @Test public void capturesLiveSelectedRegionAndRejectsConcurrentCapture() throws Exception {
        requireLiveCapture();
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> image = new AtomicReference<>();
        AtomicReference<String> failure = new AtomicReference<>();
        AtomicReference<String> secondFailure = new AtomicReference<>();
        AtomicInteger completions = new AtomicInteger();
        AtomicInteger secondCompletions = new AtomicInteger();
        BroadcastReceiver trigger = new BroadcastReceiver() {
            @Override public void onReceive(Context ignored, Intent intent) {
                OverlaySession session = OverlaySession.current;
                if (session == null || session.state != OverlaySession.State.ACTIVE || session.captureRequest == null) {
                    failure.set("An ACTIVE session with a manually confirmed region is required"); done.countDown(); return;
                }
                session.captureRequest.capture(new OverlayCaptureController.Callback() {
                    @Override public void onCaptured(String dataUrl, long revision) {
                        completions.incrementAndGet(); image.set(dataUrl); done.countDown();
                    }
                    @Override public void onFailure(String code, String message) {
                        completions.incrementAndGet(); failure.set(code + ": " + message); done.countDown();
                    }
                });
                session.captureRequest.capture(new OverlayCaptureController.Callback() {
                    @Override public void onCaptured(String dataUrl, long revision) { secondCompletions.incrementAndGet(); }
                    @Override public void onFailure(String code, String message) {
                        secondCompletions.incrementAndGet(); secondFailure.set(code);
                    }
                });
            }
        };
        register(context, trigger);
        try { assertTrue("Send the test CAPTURE_NOW broadcast after confirming a region", done.await(180, TimeUnit.SECONDS)); }
        finally { context.unregisterReceiver(trigger); }
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        assertNull(failure.get());
        assertEquals(1, completions.get()); assertEquals(1, secondCompletions.get());
        assertEquals("BUSY", secondFailure.get());
        String result = image.get(); assertNotNull(result);
        assertTrue(result.length() <= OverlayCaptureController.MAX_IMAGE_BYTES);
        byte[] jpeg = Base64.decode(result.substring(result.indexOf(',') + 1), Base64.NO_WRAP);
        Bitmap bitmap = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
        assertNotNull(bitmap);
        try {
            assertTrue(bitmap.getWidth() > 0 && bitmap.getHeight() > 0);
            assertTrue(Math.max(bitmap.getWidth(), bitmap.getHeight()) <= 2048);
            Bundle args = InstrumentationRegistry.getArguments();
            if (args.containsKey("expectedWidth")) assertEquals(Integer.parseInt(args.getString("expectedWidth")), bitmap.getWidth());
            if (args.containsKey("expectedHeight")) assertEquals(Integer.parseInt(args.getString("expectedHeight")), bitmap.getHeight());
            // Only the explicitly selected result, never a full-display buffer, is saved by this test.
            File output = new File(context.getExternalFilesDir(null), "capture-smoke.jpg");
            try (FileOutputStream file = new FileOutputStream(output)) { file.write(jpeg); }
        } finally { bitmap.recycle(); }
    }

    @Test public void stopDuringCaptureSettlesOnceAndOldRequestCannotCaptureAgain() throws Exception {
        requireLiveCapture();
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        CountDownLatch stopped = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        AtomicReference<OverlaySession.CaptureRequest> request = new AtomicReference<>();
        AtomicInteger terminals = new AtomicInteger();
        AtomicInteger stopCompletions = new AtomicInteger();
        BroadcastReceiver trigger = new BroadcastReceiver() {
            @Override public void onReceive(Context ignored, Intent intent) {
                OverlaySession session = OverlaySession.current;
                if (session == null || session.state != OverlaySession.State.ACTIVE || session.captureRequest == null) {
                    result.set("NO_ACTIVE_SESSION"); stopped.countDown(); return;
                }
                request.set(session.captureRequest);
                request.get().capture(new OverlayCaptureController.Callback() {
                    @Override public void onCaptured(String dataUrl, long revision) { terminals.incrementAndGet(); result.set("UNEXPECTED_IMAGE"); }
                    @Override public void onFailure(String code, String message) { terminals.incrementAndGet(); result.set(code); }
                });
                // Both notifications hit the same production stop route. Its completion is the
                // frame-thread release barrier, so no worker can retain a live reader afterwards.
                session.stop("CLOSED", OverlayCaptureController.CLOSED_MESSAGE, stopCompletions::incrementAndGet);
                session.stop("CLOSED", OverlayCaptureController.CLOSED_MESSAGE, () -> {
                    stopCompletions.incrementAndGet(); stopped.countDown();
                });
            }
        };
        register(context, trigger);
        try { assertTrue("Send CAPTURE_NOW after confirming a region", stopped.await(180, TimeUnit.SECONDS)); }
        finally { context.unregisterReceiver(trigger); }
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        assertEquals("CLOSED", result.get()); assertEquals(1, terminals.get()); assertEquals(2, stopCompletions.get());
        AtomicInteger lateResults = new AtomicInteger();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            assertNull(OverlaySession.current);
            request.get().capture(new OverlayCaptureController.Callback() {
                @Override public void onCaptured(String dataUrl, long revision) { fail("Stopped session produced an image"); }
                @Override public void onFailure(String code, String message) { assertEquals("CLOSED", code); lateResults.incrementAndGet(); }
            });
        });
        assertEquals(1, lateResults.get());
    }

    private static void requireLiveCapture() {
        Assume.assumeTrue("Opt in with -e liveCapture true and send CAPTURE_NOW after UI selection",
            "true".equals(InstrumentationRegistry.getArguments().getString("liveCapture")));
    }
    private static void register(Context context, BroadcastReceiver receiver) {
        ContextCompat.registerReceiver(context, receiver, new IntentFilter(CAPTURE_NOW), ContextCompat.RECEIVER_EXPORTED);
    }
}
