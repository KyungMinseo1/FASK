package io.github.kyungminseo1.fask;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.net.ServerSocket;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.tls.HeldCertificate;
import org.junit.Test;

public class EventStreamTest {
    /** Records every callback in order. */
    static final class Rec implements EventStream.Listener, EventStream.Opened {
        final BlockingQueue<String> q = new LinkedBlockingQueue<>();
        final List<String> all = new CopyOnWriteArrayList<>();
        volatile EventStream stream;

        private void add(String s) {
            all.add(s);
            q.add(s);
        }

        @Override public void onEvent(String event, String data) { add("event:" + event + ":" + data); }
        @Override public void onClosed(String code) { add("closed:" + code); }
        @Override public void onOpen(EventStream s) { stream = s; add("open"); }
        @Override public void onFailure(String code) { add("failure:" + code); }

        String next() throws InterruptedException {
            return q.poll(10, TimeUnit.SECONDS);
        }

        String none() throws InterruptedException {
            return q.poll(500, TimeUnit.MILLISECONDS);
        }
    }

    private static EventStream open(OkHttpClient c, String url, Rec r) {
        return EventStream.open(c, url, "tok", r, r);
    }

    private static MockResponse sse(String body) {
        return new MockResponse().setHeader("Content-Type", "text/event-stream").setBody(body);
    }

    @Test
    public void opensDeliversEventsAndClosesOnce() throws Exception {
        HeldCertificate a = TestCerts.leaf("a");
        try (MockWebServer s = TestCerts.tlsServer(a)) {
            s.enqueue(sse(": connected\n\n: ping\n\nevent: stream\ndata: {\"turnId\":\"x\"}\n\ndata: a\ndata:b\n\n"));
            s.start(TestCerts.loopback(), 0);
            Rec r = new Rec();
            open(PinnedTrustManager.client(TestCerts.pin(a), 5000), s.url("/events").toString(), r);
            assertEquals("open", r.next());
            assertEquals("event:stream:{\"turnId\":\"x\"}", r.next());
            assertEquals("event:message:a\nb", r.next());
            assertEquals("closed:NETWORK", r.next());
            assertNull(r.none());
            assertEquals("Bearer tok", s.takeRequest().getHeader("Authorization"));
        }
    }

    @Test
    public void pinMismatchFailsWithoutRequest() throws Exception {
        HeldCertificate a = TestCerts.leaf("a");
        try (MockWebServer s = TestCerts.tlsServer(TestCerts.leaf("b"))) {
            s.enqueue(sse(": connected\n\n"));
            s.start(TestCerts.loopback(), 0);
            Rec r = new Rec();
            open(PinnedTrustManager.client(TestCerts.pin(a), 5000), s.url("/").toString(), r);
            assertEquals("failure:PIN_MISMATCH", r.next());
            assertNull(r.none());
            assertEquals(0, s.getRequestCount());
        }
    }

    @Test
    public void unauthorized() throws Exception {
        HeldCertificate a = TestCerts.leaf("a");
        try (MockWebServer s = TestCerts.tlsServer(a)) {
            s.enqueue(new MockResponse().setResponseCode(401));
            s.start(TestCerts.loopback(), 0);
            Rec r = new Rec();
            open(PinnedTrustManager.client(TestCerts.pin(a), 5000), s.url("/").toString(), r);
            assertEquals("failure:UNAUTHORIZED", r.next());
            assertNull(r.none());
        }
    }

    @Test
    public void wrongContentTypeIsNetwork() throws Exception {
        HeldCertificate a = TestCerts.leaf("a");
        try (MockWebServer s = TestCerts.tlsServer(a)) {
            s.enqueue(new MockResponse().setHeader("Content-Type", "application/json").setBody(": connected\n\n"));
            s.start(TestCerts.loopback(), 0);
            Rec r = new Rec();
            open(PinnedTrustManager.client(TestCerts.pin(a), 5000), s.url("/").toString(), r);
            assertEquals("failure:NETWORK", r.next());
            assertNull(r.none());
        }
    }

    @Test
    public void missingConnectedPreambleIsNetwork() throws Exception {
        HeldCertificate a = TestCerts.leaf("a");
        try (MockWebServer s = TestCerts.tlsServer(a)) {
            s.enqueue(sse("event: stream\ndata: {}\n\n"));
            s.start(TestCerts.loopback(), 0);
            Rec r = new Rec();
            open(PinnedTrustManager.client(TestCerts.pin(a), 5000), s.url("/").toString(), r);
            assertEquals("failure:NETWORK", r.next());
            assertNull(r.none());
        }
    }

    @Test
    public void closedPortThenWorkingServer() throws Exception {
        HeldCertificate a = TestCerts.leaf("a");
        OkHttpClient c = PinnedTrustManager.client(TestCerts.pin(a), 5000);
        int port;
        try (ServerSocket ss = new ServerSocket(0, 1, TestCerts.loopback())) {
            port = ss.getLocalPort();
        }
        Rec r1 = new Rec();
        open(c, "https://127.0.0.1:" + port + "/", r1);
        assertEquals("failure:NETWORK", r1.next());
        try (MockWebServer s = TestCerts.tlsServer(a)) {
            s.enqueue(sse(": connected\n\n"));
            s.start(TestCerts.loopback(), 0);
            Rec r2 = new Rec();
            open(c, s.url("/").toString(), r2);
            assertEquals("open", r2.next());
        }
    }

    @Test
    public void cancelSuppressesAllLaterCallbacks() throws Exception {
        HeldCertificate a = TestCerts.leaf("a");
        try (MockWebServer s = TestCerts.tlsServer(a)) {
            StringBuilder body = new StringBuilder(": connected\n\n");
            for (int i = 0; i < 20; i++) body.append("event: stream\ndata: ").append(i).append("\n\n");
            // ": connected\n\n" (14 bytes) arrives first; the rest trickles slowly.
            s.enqueue(sse(body.toString()).throttleBody(14, 300, TimeUnit.MILLISECONDS));
            s.start(TestCerts.loopback(), 0);
            Rec r = new Rec();
            open(PinnedTrustManager.client(TestCerts.pin(a), 10000), s.url("/").toString(), r);
            assertEquals("open", r.next());
            r.stream.cancel();
            int before = r.all.size();
            Thread.sleep(1500);
            // At most an event already being dispatched at cancel time; never onClosed afterwards.
            for (String x : r.all.subList(before, r.all.size())) {
                assertTrue("unexpected callback after cancel: " + x, false);
            }
            for (String x : r.all) assertTrue(!x.startsWith("closed:"));
        }
    }
}
