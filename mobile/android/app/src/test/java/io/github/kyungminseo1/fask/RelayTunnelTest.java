package io.github.kyungminseo1.fask;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okhttp3.mockwebserver.Dispatcher;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import okhttp3.mockwebserver.SocketPolicy;
import okhttp3.tls.HeldCertificate;
import okio.Buffer;
import okio.ByteString;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class RelayTunnelTest {
    private static final String ROOM = "R".repeat(43);
    private static final int BULK = 8 * 1024 * 1024;
    private static final int SLOW = 2 * 1024 * 1024;

    enum Mode { PIPE, NO_READY, RAW, ROGUE }

    /**
     * PC-side test endpoint behind the fake relay: after `ready` it pipes decoded DATA into a socket
     * to the TLS hub and sends the hub's bytes back as DATA, honoring the credit window both ways.
     */
    static final class Endpoint extends WebSocketListener {
        final Mode mode;
        final int hubPort;
        final RelayFraming.Window window = new RelayFraming.Window();
        final AtomicInteger maxInboundFrame = new AtomicInteger();
        final AtomicLong inboundUnacked = new AtomicLong();
        final AtomicLong maxInboundUnacked = new AtomicLong();
        final AtomicLong received = new AtomicLong();
        final AtomicInteger ended = new AtomicInteger();
        volatile Socket hub;
        private long credit;

        Endpoint(Mode mode, int hubPort) {
            this.mode = mode;
            this.hubPort = hubPort;
        }

        @Override public void onOpen(WebSocket ws, Response response) {
            if (mode == Mode.NO_READY) return;
            ws.send("ready");
            if (mode == Mode.ROGUE) {
                // Ignores the window: one frame more than the receiver may hold unacked.
                for (int i = 0; i < 17; i++) ws.send(RelayFraming.data(new byte[RelayFraming.CHUNK], 0, RelayFraming.CHUNK));
                return;
            }
            if (mode == Mode.RAW) {
                daemon(() -> sendAll(ws, new byte[1024 * 1024]));
                return;
            }
            try {
                hub = new Socket("127.0.0.1", hubPort);
            } catch (IOException e) {
                ws.close(1011, null);
                return;
            }
            daemon(() -> {
                byte[] buf = new byte[RelayFraming.CHUNK];
                try {
                    InputStream in = hub.getInputStream();
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        window.acquire(n);
                        ws.send(RelayFraming.data(buf, 0, n));
                    }
                } catch (IOException | InterruptedException ignored) {
                    // Closed.
                }
                ws.close(1000, null);
            });
        }

        private void sendAll(WebSocket ws, byte[] data) {
            try {
                for (int off = 0; off < data.length; off += RelayFraming.CHUNK) {
                    int n = Math.min(RelayFraming.CHUNK, data.length - off);
                    window.acquire(n);
                    ws.send(RelayFraming.data(data, off, n));
                }
            } catch (IOException | InterruptedException ignored) {
                // Closed.
            }
        }

        @Override public synchronized void onMessage(WebSocket ws, ByteString bytes) {
            maxInboundFrame.accumulateAndGet(bytes.size(), Math::max);
            RelayFraming.Frame frame;
            try {
                frame = RelayFraming.parse(bytes);
                if (frame.type == RelayFraming.ACK) {
                    window.release(frame.credit);
                    return;
                }
                int n = frame.payload.size();
                maxInboundUnacked.accumulateAndGet(inboundUnacked.addAndGet(n), Math::max);
                if (mode == Mode.PIPE) {
                    OutputStream out = hub.getOutputStream();
                    frame.payload.write(out);
                }
                received.addAndGet(n);
            } catch (IOException e) {
                ws.close(4400, "protocol");
                return;
            }
            credit += frame.payload.size();
            if (credit >= RelayFraming.ACK_EVERY) {
                inboundUnacked.addAndGet(-credit);
                ws.send(RelayFraming.ack((int) credit));
                credit = 0;
            }
        }

        @Override public void onClosing(WebSocket ws, int code, String reason) {
            ws.close(1000, null);
            stop();
        }

        @Override public void onClosed(WebSocket ws, int code, String reason) {
            ended.incrementAndGet();
            stop();
        }

        @Override public void onFailure(WebSocket ws, Throwable t, Response response) {
            ended.incrementAndGet();
            stop();
        }

        private void stop() {
            window.close();
            Socket s = hub;
            if (s != null) {
                try { s.close(); } catch (IOException ignored) { }
            }
        }
    }

    /** Fake relay: upgrades every connect to an Endpoint, or answers with a fixed status. */
    static final class Relay extends Dispatcher {
        volatile int status = 101;
        volatile Mode mode = Mode.PIPE;
        volatile int hubPort;
        final List<Endpoint> endpoints = new CopyOnWriteArrayList<>();

        @Override public MockResponse dispatch(RecordedRequest request) {
            if (status != 101) return new MockResponse().setResponseCode(status);
            Endpoint endpoint = new Endpoint(mode, hubPort);
            endpoints.add(endpoint);
            return new MockResponse().withWebSocketUpgrade(endpoint);
        }

        Endpoint last() {
            return endpoints.get(endpoints.size() - 1);
        }
    }

    /** The PC hub: pinned TLS, closes every connection after one response like an idle keep-alive would. */
    static final class Hub extends Dispatcher {
        final AtomicLong lastBody = new AtomicLong();

        @Override public MockResponse dispatch(RecordedRequest request) {
            // The real hub ends idle keep-alive connections itself; this one does so right away.
            MockResponse response = new MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_END);
            if ("/health".equals(request.getPath())) return response.setBody("{\"app\":\"fask\"}");
            if ("/bulk".equals(request.getPath())) {
                lastBody.set(request.getBodySize());
                return response.setBody(new Buffer().write(fill(BULK, (byte) 'x')));
            }
            if ("/slow".equals(request.getPath())) return response.setBody(new Buffer().write(fill(SLOW, (byte) 's')));
            return response.setResponseCode(404);
        }
    }

    private HeldCertificate cert;
    private MockWebServer hubServer;
    private MockWebServer relayServer;
    private Hub hub;
    private Relay relay;
    private String relayUrl;
    private final List<Socket> raw = new ArrayList<>();

    @Before public void setUp() throws Exception {
        cert = TestCerts.leaf("hub");
        hubServer = TestCerts.tlsServer(cert);
        hub = new Hub();
        hubServer.setDispatcher(hub);
        // The Node hub offers no h2 over ALPN; keep per-connection HTTP/1.1 semantics.
        hubServer.setProtocols(List.of(Protocol.HTTP_1_1));
        hubServer.start(TestCerts.loopback(), 0);
        relayServer = new MockWebServer();
        relay = new Relay();
        relay.hubPort = hubServer.getPort();
        relayServer.setDispatcher(relay);
        relayServer.start(TestCerts.loopback(), 0);
        relayUrl = "ws://127.0.0.1:" + relayServer.getPort();
    }

    @After public void tearDown() throws Exception {
        for (Socket s : raw) s.close();
        relayServer.shutdown();
        hubServer.shutdown();
    }

    private static byte[] fill(int size, byte value) {
        byte[] b = new byte[size];
        Arrays.fill(b, value);
        return b;
    }

    private static void daemon(Runnable body) {
        Thread t = new Thread(body);
        t.setDaemon(true);
        t.start();
    }

    private static void waitUntil(String what, long timeoutMs, BooleanSupplier condition) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        while (!condition.getAsBoolean()) {
            assertTrue(what, System.nanoTime() < deadline);
            Thread.sleep(10);
        }
    }

    private RelayTunnel tunnel(long readyMs, long idleMs, long offlineMs) {
        return new RelayTunnel(relayUrl, ROOM, readyMs, idleMs, offlineMs);
    }

    private static final class Result implements HubHttpClient.RequestCallback {
        final BlockingQueue<String> q = new LinkedBlockingQueue<>();
        volatile String body;

        @Override public void onResponse(int status, String body) {
            this.body = body;
            q.add("response:" + status);
        }

        @Override public void onFailure(String code) {
            q.add("failure:" + code);
        }

        String next() throws InterruptedException {
            return q.poll(20, TimeUnit.SECONDS);
        }
    }

    private Result request(String url, String method, String body, String pin) {
        Result result = new Result();
        new HubHttpClient().request(url, method, body, pin, "secret", 20000, result);
        return result;
    }

    private Socket connect(int port) throws IOException {
        Socket s = new Socket();
        raw.add(s);
        s.connect(new InetSocketAddress("127.0.0.1", port), 2000);
        return s;
    }

    @Test public void healthThroughResolveWithTheRightPin() throws Exception {
        String url = RelayTunnel.resolve("https://relay.invalid:47615/health", relayUrl, ROOM);
        assertTrue(url.startsWith("https://127.0.0.1:"));
        Result result = request(url, "GET", null, TestCerts.pin(cert));
        assertEquals("response:200", result.next());
        assertEquals("{\"app\":\"fask\"}", result.body);
        assertEquals("https://10.0.0.1:47615/health", RelayTunnel.resolve("https://10.0.0.1:47615/health", null, null));
    }

    @Test public void wrongPinIsPinMismatch() throws Exception {
        String url = RelayTunnel.resolve("https://relay.invalid:47615/health", relayUrl, ROOM);
        Result result = request(url, "GET", null, TestCerts.pin(TestCerts.leaf("other")));
        assertEquals("failure:PIN_MISMATCH", result.next());
    }

    @Test(expected = IOException.class)
    public void relayAddressWithoutRelayIdentityFails() throws Exception {
        RelayTunnel.resolve("https://relay.invalid:47615/health", null, null);
    }

    @Test public void hostOfflineIsNetworkAndBacksOffWithoutNewRelayRequests() throws Exception {
        relay.status = 503;
        RelayTunnel tunnel = tunnel(15000, 60000, 5000);
        String url = "https://127.0.0.1:" + tunnel.port() + "/health";
        assertEquals("failure:NETWORK", request(url, "GET", null, TestCerts.pin(cert)).next());
        waitUntil("pipe released", 2000, () -> tunnel.activePipes() == 0);
        int requests = relayServer.getRequestCount();
        assertEquals("failure:NETWORK", request(url, "GET", null, TestCerts.pin(cert)).next());
        assertEquals(requests, relayServer.getRequestCount());
    }

    @Test public void missingReadyTimesOutAsNetwork() throws Exception {
        relay.mode = Mode.NO_READY;
        RelayTunnel tunnel = tunnel(300, 60000, 5000);
        String url = "https://127.0.0.1:" + tunnel.port() + "/health";
        assertEquals("failure:NETWORK", request(url, "GET", null, TestCerts.pin(cert)).next());
        waitUntil("pipe released", 2000, () -> tunnel.activePipes() == 0);
    }

    @Test public void concurrentRequestsAllSucceedAndReleasePipes() throws Exception {
        RelayTunnel tunnel = tunnel(15000, 60000, 5000);
        String url = "https://127.0.0.1:" + tunnel.port() + "/health";
        List<Result> results = new ArrayList<>();
        for (int i = 0; i < 8; i++) results.add(request(url, "GET", null, TestCerts.pin(cert)));
        for (Result r : results) assertEquals("response:200", r.next());
        waitUntil("pipes released", 5000, () -> tunnel.activePipes() == 0);
    }

    @Test public void connectionsBeyondTheCapAreClosedAtOnce() throws Exception {
        RelayTunnel tunnel = tunnel(15000, 60000, 5000);
        int port = tunnel.port();
        for (int i = 0; i < RelayTunnel.MAX_PIPES; i++) connect(port);
        waitUntil("pipes open", 5000, () -> tunnel.activePipes() == RelayTunnel.MAX_PIPES);
        Socket extra = connect(port);
        extra.setSoTimeout(2000);
        assertEquals(-1, extra.getInputStream().read());
        assertEquals(RelayTunnel.MAX_PIPES, tunnel.activePipes());
    }

    @Test public void idleTunnelStopsListeningAndRebindsOnResolve() throws Exception {
        RelayTunnel tunnel = tunnel(15000, 200, 5000);
        assertEquals("response:200", request("https://127.0.0.1:" + tunnel.port() + "/health", "GET", null, TestCerts.pin(cert)).next());
        waitUntil("listener closed", 3000, () -> !tunnel.listening());
        assertEquals("response:200", request("https://127.0.0.1:" + tunnel.port() + "/health", "GET", null, TestCerts.pin(cert)).next());
        assertTrue(tunnel.listening());
    }

    @Test public void bulkTransferIsIntactAndWindowed() throws Exception {
        RelayTunnel tunnel = tunnel(15000, 60000, 5000);
        String upload = new String(fill(BULK, (byte) 'y'), "US-ASCII");
        Result result = request("https://127.0.0.1:" + tunnel.port() + "/bulk", "POST", upload, TestCerts.pin(cert));
        assertEquals("response:200", result.next());
        assertEquals(BULK, result.body.length());
        assertTrue(result.body.chars().allMatch(c -> c == 'x'));
        assertEquals(BULK, hub.lastBody.get());
        Endpoint endpoint = relay.last();
        assertTrue("frame " + endpoint.maxInboundFrame.get(), endpoint.maxInboundFrame.get() <= RelayFraming.MAX_FRAME);
        assertTrue("tunnel unacked " + endpoint.maxInboundUnacked.get(), endpoint.maxInboundUnacked.get() <= RelayFraming.WINDOW);
        assertTrue("endpoint unacked " + endpoint.window.maxUnacked(), endpoint.window.maxUnacked() <= RelayFraming.WINDOW);
        assertTrue(endpoint.window.maxUnacked() > 0);
    }

    @Test public void slowConsumerCompletesWithinTheWindow() throws Exception {
        RelayTunnel tunnel = tunnel(15000, 60000, 5000);
        OkHttpClient client = PinnedTrustManager.client(TestCerts.pin(cert), 30000);
        Request req = new Request.Builder().url("https://127.0.0.1:" + tunnel.port() + "/slow")
            .header("Authorization", "Bearer secret").build();
        long total = 0;
        try (Response response = client.newCall(req).execute()) {
            assertEquals(200, response.code());
            InputStream in = response.body().byteStream();
            byte[] buf = new byte[16384];
            int n;
            // Real time on purpose: the consumer must stay slower than the relay can deliver.
            while ((n = in.read(buf)) > 0) {
                total += n;
                Thread.sleep(20);
            }
        }
        assertEquals(SLOW, total);
        assertTrue(relay.last().window.maxUnacked() <= RelayFraming.WINDOW);
    }

    @Test public void writingWithoutReadingDoesNotDeadlock() throws Exception {
        relay.mode = Mode.RAW;
        RelayTunnel tunnel = tunnel(15000, 60000, 5000);
        Socket s = connect(tunnel.port());
        AtomicLong written = new AtomicLong();
        Thread writer = new Thread(() -> {
            try {
                OutputStream out = s.getOutputStream();
                byte[] chunk = new byte[65536];
                for (int i = 0; i < 64; i++) {
                    out.write(chunk);
                    written.addAndGet(chunk.length);
                }
            } catch (IOException ignored) {
                // Reported by the assertion below.
            }
        });
        writer.start();
        writer.join(10000);
        assertEquals(4L * 1024 * 1024, written.get());
        waitUntil("endpoint received upload", 10000, () -> relay.last().received.get() == 4L * 1024 * 1024);
        s.setSoTimeout(10000);
        InputStream in = s.getInputStream();
        long read = 0;
        byte[] buf = new byte[65536];
        while (read < 1024 * 1024) {
            int n = in.read(buf);
            assertTrue(n > 0);
            read += n;
        }
        assertEquals(1024 * 1024, read);
    }

    @Test public void relaySideWindowViolationClosesThePipe() throws Exception {
        relay.mode = Mode.ROGUE;
        RelayTunnel tunnel = tunnel(15000, 60000, 5000);
        Socket s = new Socket();
        raw.add(s);
        // A client that does not read keeps the tunnel from crediting what it received.
        s.setReceiveBufferSize(4096);
        s.connect(new InetSocketAddress("127.0.0.1", tunnel.port()), 2000);
        waitUntil("rogue frames sent", 5000, () -> !relay.endpoints.isEmpty());
        waitUntil("pipe closed", 5000, () -> tunnel.activePipes() == 0);
        s.setSoTimeout(5000);
        InputStream in = s.getInputStream();
        ByteArrayOutputStream drained = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        try {
            int n;
            while ((n = in.read(buf)) >= 0) drained.write(buf, 0, n);
        } catch (SocketTimeoutException e) {
            throw new AssertionError("local socket stayed open", e);
        } catch (IOException reset) {
            // A reset also ends the stream.
        }
        assertTrue(drained.size() < 17 * RelayFraming.CHUNK);
    }

    @Test public void finishedTunnelReleasesThreadsSocketsAndListener() throws Exception {
        RelayTunnel tunnel = tunnel(15000, 200, 5000);
        String base = "https://127.0.0.1:" + tunnel.port();
        List<Result> results = new ArrayList<>();
        for (int i = 0; i < 8; i++) results.add(request(base + "/health", "GET", null, TestCerts.pin(cert)));
        results.add(request(base + "/bulk", "POST", new String(fill(BULK, (byte) 'y'), "US-ASCII"), TestCerts.pin(cert)));
        for (Result r : results) assertEquals("response:200", r.next());
        waitUntil("pipes released", 5000, () -> tunnel.activePipes() == 0);
        waitUntil("listener closed", 3000, () -> !tunnel.listening());
        waitUntil("relay threads exited", 2000, () -> RelayTunnel.liveThreads() == 0);
        waitUntil("every relay socket closed", 5000, () -> relay.endpoints.stream().allMatch(e -> e.ended.get() > 0));
        assertEquals(9, relay.endpoints.size());
    }

    @Test public void framingRejectsMalformedFrames() {
        for (byte[] bad : new byte[][] {
            {}, { 0 }, { 2, 1 }, { 1, 0, 0, 0 }, { 1, 0, 0, 0, 0 }, { 1, 0, 4, 0, 1 }
        }) {
            try {
                RelayFraming.parse(ByteString.of(bad));
                throw new AssertionError("accepted " + Arrays.toString(bad));
            } catch (IOException expected) {
                // Rejected.
            }
        }
        assertArrayEquals(new byte[] { 1, 0, 1, 0, 0 }, RelayFraming.ack(65536).toByteArray());
    }
}
