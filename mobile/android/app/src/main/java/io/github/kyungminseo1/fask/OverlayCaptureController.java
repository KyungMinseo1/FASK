package io.github.kyungminseo1.fask;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.RectF;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.util.List;
import java.util.UUID;

/** Main-thread capture transactions; the frame thread exclusively owns projection/reader/images. */
final class OverlayCaptureController {
    static final String CLOSED_MESSAGE = "화면 공유가 종료되었습니다. 앱에서 다시 시작해 주세요.";
    static final String GEOMETRY_MESSAGE = "화면 구성이 바뀌었습니다. 영역을 다시 선택해 주세요.";
    static final String FULL_DISPLAY_MESSAGE = "전체 화면 공유로 다시 시작해 주세요.";
    static final int MAX_IMAGE_BYTES = 15 * 1024 * 1024;
    private static final long CAPTURE_TIMEOUT_MS = 3000;

    interface Callback {
        void onCaptured(String dataUrl, long inkRevision);
        void onFailure(String code, String message);
    }
    interface SessionGuard { boolean isActive(); }
    interface Listener {
        void onReadyChanged(boolean ready, long readerGeneration);
        void onCapturedContentResize(int width, int height, boolean changed);
        void onFailure(String code, String message);
    }

    /** Frozen values never depend on a later view layout, selection, or editable stroke list. */
    static final class Snapshot {
        final String captureId = UUID.randomUUID().toString();
        final String sessionId;
        final long sessionEpoch;
        final OverlayGeometry.GeometrySnapshot geometry;
        final long geometryEpoch;
        final long readerGeneration;
        final long inkRevision;
        final OverlayGeometry.PixelRect rect;
        final List<OverlayInkView.Stroke> strokes;
        Snapshot(String sessionId, long sessionEpoch, OverlayGeometry.GeometrySnapshot geometry,
                 long inkRevision, OverlayGeometry.PixelRect rect, List<OverlayInkView.Stroke> strokes) {
            this.sessionId = sessionId; this.sessionEpoch = sessionEpoch; this.geometry = geometry;
            this.geometryEpoch = geometry.epoch; this.readerGeneration = geometry.readerGeneration;
            this.inkRevision = inkRevision; this.rect = rect; this.strokes = strokes;
        }
    }
    private static final class Operation {
        final Snapshot snapshot;
        final OverlayWindowController windows;
        final Callback callback;
        volatile boolean cancelled;
        boolean terminal;
        Runnable timeout;
        long barrierSequence;
        long barrierTimestamp;
        Operation(Snapshot snapshot, OverlayWindowController windows, Callback callback) {
            this.snapshot = snapshot; this.windows = windows; this.callback = callback;
        }
    }

    private final Context context;
    private final Handler main;
    private final HandlerThread thread = new HandlerThread("FaskCapture");
    private final Handler frames;
    private final String sessionId;
    private final long sessionEpoch;
    private final SessionGuard guard;
    private final Listener listener;
    private Rect bounds;
    private long generation = 1;
    private boolean freshFrame;
    private boolean capturedSizeKnown;
    private int capturedWidth;
    private int capturedHeight;
    private boolean ready;
    private volatile boolean closed;
    private Operation pending;

    // Access only on frames. Image acquisition, replacement, encoding and release are serialized.
    private MediaProjection projection;
    private MediaProjection.Callback projectionCallback;
    private VirtualDisplay virtualDisplay;
    private ImageReader reader;
    private long frameGeneration;
    private long frameSequence;
    private long lastTimestamp = Long.MIN_VALUE;
    private boolean frameReadyPublished;
    private Operation awaitingFrame;

    OverlayCaptureController(Context context, Handler main, String sessionId, long sessionEpoch,
                             SessionGuard guard, Listener listener) {
        checkMain();
        this.context = context; this.main = main; this.sessionId = sessionId;
        this.sessionEpoch = sessionEpoch; this.guard = guard; this.listener = listener;
        thread.start();
        frames = new Handler(thread.getLooper());
    }

    private static void checkMain() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Capture requires main thread");
    }
    long getReaderGeneration() { return generation; }
    boolean isReady() { return ready && !closed; }

    void start(int resultCode, Intent consent, Rect displayBounds, int densityDpi) {
        checkMain();
        bounds = new Rect(displayBounds);
        final Rect initial = new Rect(bounds);
        final long initialGeneration = generation;
        frames.post(() -> {
            if (closed) return;
            try {
                MediaProjectionManager manager = (MediaProjectionManager) context.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
                projection = manager.getMediaProjection(resultCode, consent);
                if (projection == null) throw new IllegalStateException("No projection");
                projectionCallback = new MediaProjection.Callback() {
                    @Override public void onStop() { failSession("CLOSED", CLOSED_MESSAGE); }
                    @Override public void onCapturedContentResize(int width, int height) {
                        if (closed) return;
                        boolean changed = capturedSizeKnown && (capturedWidth != width || capturedHeight != height);
                        capturedSizeKnown = true; capturedWidth = width; capturedHeight = height;
                        // Refresh default-display metrics before checking a possibly rotated frame.
                        listener.onCapturedContentResize(width, height, changed);
                        if (closed) return;
                        if (width != bounds.width() || height != bounds.height()) {
                            failSession("UNSUPPORTED_CAPTURE", FULL_DISPLAY_MESSAGE);
                        } else publishReady();
                    }
                };
                projection.registerCallback(projectionCallback, main);
                if (closed) { releaseFrames(); return; }
                installReader(initial, initialGeneration);
                // One and only one createVirtualDisplay call per consent/session.
                virtualDisplay = projection.createVirtualDisplay("FASK screen question", initial.width(), initial.height(),
                    densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, frames);
                if (virtualDisplay == null) throw new IllegalStateException("No virtual display");
                if (closed) releaseFrames();
            } catch (RuntimeException error) {
                failSession("START_FAILED", "화면 공유 초기화에 실패했습니다. 앱에서 다시 시작해 주세요.");
            }
        });
    }

    void updateDisplay(Rect displayBounds, int densityDpi) {
        checkMain();
        if (closed) return;
        cancelCapture("GEOMETRY_CHANGED", GEOMETRY_MESSAGE);
        bounds = new Rect(displayBounds);
        freshFrame = false; ready = false;
        final long nextGeneration = ++generation;
        final Rect nextBounds = new Rect(bounds);
        listener.onReadyChanged(false, nextGeneration);
        frames.post(() -> {
            if (closed) return;
            try {
                ImageReader previous = reader;
                reader = null; awaitingFrame = null;
                if (previous != null) previous.setOnImageAvailableListener(null, null);
                try {
                    virtualDisplay.setSurface(null);
                    installReader(nextBounds, nextGeneration);
                    virtualDisplay.resize(nextBounds.width(), nextBounds.height(), densityDpi);
                    virtualDisplay.setSurface(reader.getSurface());
                } finally { if (previous != null) previous.close(); }
            } catch (RuntimeException error) {
                failSession("START_FAILED", "화면 프레임을 갱신할 수 없습니다. 앱에서 다시 시작해 주세요.");
            }
        });
    }

    private void installReader(Rect size, long readerGeneration) {
        frameGeneration = readerGeneration;
        frameSequence = 0; lastTimestamp = Long.MIN_VALUE; frameReadyPublished = false;
        ImageReader next = ImageReader.newInstance(size.width(), size.height(), PixelFormat.RGBA_8888, 2);
        reader = next;
        next.setOnImageAvailableListener(source -> receiveFrame(source, readerGeneration, size), frames);
    }

    private void receiveFrame(ImageReader source, long readerGeneration, Rect expected) {
        Image image = null;
        Operation processing = null;
        try {
            if (source != reader || closed || readerGeneration != frameGeneration) return;
            image = source.acquireLatestImage();
            if (image == null) return;
            long sequence = ++frameSequence;
            long timestamp = image.getTimestamp();
            lastTimestamp = Math.max(lastTimestamp, timestamp);
            if (image.getWidth() != expected.width() || image.getHeight() != expected.height()) {
                failSession("UNSUPPORTED_CAPTURE", FULL_DISPLAY_MESSAGE); return;
            }
            if (!frameReadyPublished) {
                frameReadyPublished = true;
                main.post(() -> {
                    if (!closed && generation == readerGeneration) { freshFrame = true; publishReady(); }
                });
            }
            Operation operation = awaitingFrame;
            // Idle frames are closed here without pixel reads, allocation or encoding.
            if (operation == null || operation.cancelled || sequence <= operation.barrierSequence
                || timestamp <= operation.barrierTimestamp) return;
            awaitingFrame = null;
            processing = operation;
            Snapshot snapshot = operation.snapshot;
            if (snapshot.readerGeneration != readerGeneration || closed || operation.cancelled) return;
            Rect imageCrop = image.getCropRect();
            Image.Plane[] planes = image.getPlanes();
            if (planes.length != 1 || !OverlayGeometry.matchesReader(snapshot.geometry, snapshot.geometryEpoch,
                readerGeneration, image.getWidth(), image.getHeight())) throw new IllegalArgumentException("Mismatched frame");
            Image.Plane plane = planes[0];
            int[] pixels = OverlayFramePixels.cropRgba(plane.getBuffer(), image.getWidth(), image.getHeight(),
                plane.getRowStride(), plane.getPixelStride(), new OverlayGeometry.PixelRect(imageCrop.left,
                    imageCrop.top, imageCrop.right, imageCrop.bottom), snapshot.rect);
            // Pixels outside the selected crop are never copied. Release the source before Bitmap work.
            Image consumed = image; image = null; consumed.close();
            if (operation.cancelled || closed) return;
            Bitmap bitmap = compose(pixels, snapshot.rect, snapshot.strokes);
            String result;
            try {
                if (operation.cancelled || closed) return;
                result = encode(bitmap);
            } finally { bitmap.recycle(); }
            if (operation.cancelled || closed) return;
            main.post(() -> {
                if (!matches(operation)) { finish(operation, null, "GEOMETRY_CHANGED", GEOMETRY_MESSAGE); return; }
                finish(operation, result, null, null);
            });
        } catch (RuntimeException | OutOfMemoryError error) {
            Operation failed = processing != null ? processing : awaitingFrame;
            awaitingFrame = null;
            if (failed != null) {
                main.post(() -> finish(failed, null, "CAPTURE_FAILED", "선택 영역을 캡처할 수 없습니다. 다시 시도해 주세요."));
            } else failSession("CAPTURE_FAILED", "화면 프레임을 읽을 수 없습니다.");
        } finally { if (image != null) { Image unused = image; release(unused::close); } }
    }

    private void publishReady() {
        checkMain();
        if (closed) return;
        boolean next = freshFrame && (Build.VERSION.SDK_INT < 34 || (capturedSizeKnown
            && capturedWidth == bounds.width() && capturedHeight == bounds.height()));
        if (ready != next) { ready = next; listener.onReadyChanged(next, generation); }
    }

    void captureSelectedRegion(OverlayWindowController windows, Callback callback) {
        checkMain();
        if (closed || !guard.isActive()) { callback.onFailure("CLOSED", CLOSED_MESSAGE); return; }
        if (pending != null) { callback.onFailure("BUSY", "이미 화면을 캡처하고 있습니다."); return; }
        OverlayInkView ink = windows.getInk();
        RectF selected = ink.getRegion();
        if (selected == null) { callback.onFailure("NO_REGION", "먼저 캡처 영역을 선택해 주세요."); return; }
        if (!ready || !windows.isGeometryReady() || !ink.getMatrix().isIdentity()) {
            callback.onFailure("GEOMETRY_CHANGED", GEOMETRY_MESSAGE); return;
        }
        Operation operation;
        try {
            OverlayGeometry.GeometrySnapshot geometry = windows.getGeometry();
            if (!OverlayGeometry.matchesReader(geometry, geometry.epoch, generation, bounds.width(), bounds.height())) {
                callback.onFailure("GEOMETRY_CHANGED", GEOMETRY_MESSAGE); return;
            }
            OverlayGeometry.PixelRect rect = OverlayGeometry.crop(geometry, ink.getRegionEpoch(),
                new OverlayGeometry.RegionRect(selected.left, selected.top, selected.right, selected.bottom));
            if ((long) rect.width() * rect.height() > OverlayFramePixels.MAX_PIXELS) {
                callback.onFailure("IMAGE_TOO_LARGE", "선택 영역이 너무 큽니다. 영역을 줄여 주세요."); return;
            }
            // Main-thread atomic snapshot + immediate lock: no React effect or later gesture can race it.
            windows.setCaptureLocked(true);
            Snapshot snapshot = new Snapshot(sessionId, sessionEpoch, geometry, ink.getRevision(), rect, ink.snapshotStrokes());
            operation = new Operation(snapshot, windows, callback);
            pending = operation;
            operation.timeout = () -> finish(operation, null, "CAPTURE_TIMEOUT", "새 화면 프레임을 받지 못했습니다. 다시 시도해 주세요.");
            main.postDelayed(operation.timeout, CAPTURE_TIMEOUT_MS);
            windows.hideForCapture(snapshot.captureId, () -> armBarrier(operation));
        } catch (RuntimeException error) {
            if (pending != null) finish(pending, null, "CAPTURE_FAILED", "캡처 창을 숨길 수 없습니다.");
            else { windows.setCaptureLocked(false); callback.onFailure("GEOMETRY_CHANGED", GEOMETRY_MESSAGE); }
        }
    }

    private void armBarrier(Operation operation) {
        checkMain();
        if (!matches(operation)) { finish(operation, null, "GEOMETRY_CHANGED", GEOMETRY_MESSAGE); return; }
        frames.post(() -> {
            if (closed || operation.cancelled || frameGeneration != operation.snapshot.readerGeneration || reader == null) return;
            try {
                // Same-reader timestamps/sequences only; never compare Image time to System.nanoTime.
                Image queued;
                while ((queued = reader.acquireNextImage()) != null) {
                    try { frameSequence++; lastTimestamp = Math.max(lastTimestamp, queued.getTimestamp()); }
                    finally { queued.close(); }
                }
                operation.barrierSequence = frameSequence;
                operation.barrierTimestamp = lastTimestamp;
                awaitingFrame = operation;
            } catch (RuntimeException error) {
                main.post(() -> finish(operation, null, "CAPTURE_FAILED", "새 화면 프레임을 기다릴 수 없습니다."));
            }
        });
    }

    private boolean matches(Operation operation) {
        checkMain();
        if (closed || pending != operation || operation.terminal || operation.cancelled || !guard.isActive()) return false;
        Snapshot s = operation.snapshot;
        return s.sessionId.equals(sessionId) && s.sessionEpoch == sessionEpoch && s.readerGeneration == generation
            && s.geometryEpoch == operation.windows.getGeometry().epoch
            && s.inkRevision == operation.windows.getInk().getRevision();
    }

    void cancelCapture(String code, String message) {
        checkMain();
        if (pending != null) finish(pending, null, code, message);
    }

    private void finish(Operation operation, String result, String code, String message) {
        checkMain();
        if (pending != operation || operation.terminal) return;
        // Validate again immediately before the native/bridge reply, not just after encoding.
        if (result != null && !matches(operation)) {
            result = null; code = closed || !guard.isActive() ? "CLOSED" : "GEOMETRY_CHANGED";
            message = "CLOSED".equals(code) ? CLOSED_MESSAGE : GEOMETRY_MESSAGE;
        }
        operation.terminal = true; operation.cancelled = true;
        main.removeCallbacks(operation.timeout);
        frames.post(() -> { if (awaitingFrame == operation) awaitingFrame = null; });
        try {
            operation.windows.restoreAfterCapture(operation.snapshot.captureId, !closed && guard.isActive());
        } catch (RuntimeException error) {
            result = null; code = "CAPTURE_FAILED"; message = "화면 질문 창을 복원할 수 없습니다.";
            failSession("OVERLAY_PERMISSION", message);
        } finally { pending = null; }
        if (result != null) operation.callback.onCaptured(result, operation.snapshot.inkRevision);
        else operation.callback.onFailure(code, message);
    }

    private void failSession(String code, String message) {
        main.post(() -> { if (!closed) listener.onFailure(code, message); });
    }

    void close(Runnable released) {
        checkMain();
        if (closed) return;
        closed = true; ready = false;
        try { cancelCapture("CLOSED", CLOSED_MESSAGE); }
        finally {
            frames.post(() -> {
                try { releaseFrames(); }
                finally { main.post(released); thread.quitSafely(); }
            });
        }
    }

    private static void release(Runnable release) {
        try { release.run(); } catch (RuntimeException error) { Log.w("FaskOverlay", "Capture resource release failed"); }
    }
    private void releaseFrames() {
        awaitingFrame = null;
        ImageReader images = reader; reader = null;
        if (images != null) { release(() -> images.setOnImageAvailableListener(null, null)); release(images::close); }
        VirtualDisplay virtual = virtualDisplay; virtualDisplay = null;
        if (virtual != null) release(virtual::release);
        MediaProjection media = projection; projection = null;
        MediaProjection.Callback callback = projectionCallback; projectionCallback = null;
        if (media != null) {
            if (callback != null) release(() -> media.unregisterCallback(callback));
            release(media::stop);
        }
    }

    /** Android Bitmap path shared with instrumentation, before lossy JPEG encoding. */
    static Bitmap compose(int[] pixels, OverlayGeometry.PixelRect crop, List<OverlayInkView.Stroke> strokes) {
        if ((long) crop.width() * crop.height() > OverlayFramePixels.MAX_PIXELS
            || pixels.length != (long) crop.width() * crop.height()) throw new IllegalArgumentException("Invalid crop pixels");
        Bitmap bitmap = Bitmap.createBitmap(crop.width(), crop.height(), Bitmap.Config.ARGB_8888);
        try {
            bitmap.setPixels(pixels, 0, crop.width(), 0, 0, crop.width(), crop.height());
            Canvas canvas = new Canvas(bitmap);
            canvas.translate(-crop.left, -crop.top);
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            for (OverlayInkView.Stroke stroke : strokes) stroke.draw(canvas, paint);
            return bitmap;
        } catch (RuntimeException | OutOfMemoryError error) { bitmap.recycle(); throw error; }
    }

    private static final class JpegOutput extends ByteArrayOutputStream {
        private void check(int amount) {
            if ((long) count + amount > MAX_IMAGE_BYTES) throw new IllegalArgumentException("Image too large");
        }
        @Override public synchronized void write(int value) { check(1); super.write(value); }
        @Override public synchronized void write(byte[] buffer, int offset, int length) {
            check(length); super.write(buffer, offset, length);
        }
        String dataUrl() {
            String prefix = "data:image/jpeg;base64,";
            if (prefix.length() + ((long) count + 2) / 3 * 4 > MAX_IMAGE_BYTES) {
                throw new IllegalArgumentException("Capture reply too large");
            }
            return prefix + Base64.encodeToString(buf, 0, count, Base64.NO_WRAP);
        }
    }

    static String encode(Bitmap bitmap) {
        Bitmap scaled = bitmap;
        try {
            int longest = Math.max(bitmap.getWidth(), bitmap.getHeight());
            if (longest > 2048) {
                double ratio = 2048d / longest;
                scaled = Bitmap.createScaledBitmap(bitmap, Math.max(1, (int) Math.round(bitmap.getWidth() * ratio)),
                    Math.max(1, (int) Math.round(bitmap.getHeight() * ratio)), true);
            }
            JpegOutput bytes = new JpegOutput();
            if (!scaled.compress(Bitmap.CompressFormat.JPEG, 90, bytes)) throw new IllegalStateException("JPEG encoding failed");
            return bytes.dataUrl();
        } finally { if (scaled != bitmap) scaled.recycle(); }
    }
}
