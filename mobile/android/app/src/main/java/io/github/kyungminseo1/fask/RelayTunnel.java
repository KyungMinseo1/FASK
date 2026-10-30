package io.github.kyungminseo1.fask;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Maps the relay pseudo-address to a loopback port. Every local TCP connection becomes one relay
 * WebSocket carrying the hub's end-to-end TLS bytes, so the pinned client is unchanged. Retry
 * timing stays in the JS hub client: a pipe never reconnects by itself.
 */
public final class RelayTunnel {
    static final String ADDRESS = "relay.invalid";
    static final int MAX_PIPES = 32;
    static final long READY_TIMEOUT_MS = 15000;
    static final long IDLE_CLOSE_MS = 60000;
    static final long HOST_OFFLINE_BACKOFF_MS = 15000;

    private static final Map<String, RelayTunnel> TUNNELS = new HashMap<>();
    // System CA trust for wss; the hub's own TLS session inside stays pinned by the caller.
    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        // TLS ciphertext does not compress; deflating it only costs CPU on both ends.
        .minWebSocketMessageToCompress(Long.MAX_VALUE)
        .build();
    private static final ScheduledExecutorService TIMERS = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "fask-relay-timer");
        t.setDaemon(true);
        return t;
    });
    private static final AtomicInteger PIPE_IDS = new AtomicInteger();
    /** Wakes the downlink thread without data. */
    private static final ByteString STOP = ByteString.of((byte) 0);
    /** Queued after the last inbound DATA once the relay closed the pipe. */
    private static final ByteString END = ByteString.of((byte) 1);

    private final String relayUrl;
    private final String room;
    private final long readyTimeoutMs;
    private final long idleCloseMs;
    private final long offlineBackoffMs;
    private final Set<Pipe> pipes = new HashSet<>();
    private ServerSocket server;
    private ScheduledFuture<?> idleCheck;
    private long offlineUntil;
    private long lastResolveAt;

    RelayTunnel(String relayUrl, String room, long readyTimeoutMs, long idleCloseMs, long offlineBackoffMs) {
        this.relayUrl = relayUrl;
        this.room = room;
        this.readyTimeoutMs = readyTimeoutMs;
        this.idleCloseMs = idleCloseMs;
        this.offlineBackoffMs = offlineBackoffMs;
    }

    /** Rewrites a hub URL on {@link #ADDRESS} to this process's loopback tunnel; other URLs pass through. */
    static String resolve(String url, String relayUrl, String room) throws IOException {
        HttpUrl parsed = url == null ? null : HttpUrl.parse(url);
        if (parsed == null || !ADDRESS.equals(parsed.host())) return url;
        if (relayUrl == null || room == null || !(relayUrl.startsWith("wss://") || relayUrl.startsWith("ws://"))
            || !room.matches("[A-Za-z0-9_-]{43}")) {
            throw new IOException("relay");
        }
        return parsed.newBuilder().host("127.0.0.1").port(of(relayUrl, room).port()).build().toString();
    }

    static RelayTunnel of(String relayUrl, String room) {
        synchronized (RelayTunnel.class) {
            return TUNNELS.computeIfAbsent(relayUrl + "|" + room, k ->
                new RelayTunnel(relayUrl, room, READY_TIMEOUT_MS, IDLE_CLOSE_MS, HOST_OFFLINE_BACKOFF_MS));
        }
    }

    private static long now() {
        return System.nanoTime() / 1_000_000L;
    }

    private static void closeQuietly(Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (IOException ignored) {
            // Already closed.
        }
    }

    synchronized int port() throws IOException {
        lastResolveAt = now();
        if (server == null || server.isClosed()) {
            // A literal address: no lookup, and never the IPv6 loopback the rewritten URL does not name.
            ServerSocket s = new ServerSocket(0, 50, InetAddress.getByAddress(new byte[] { 127, 0, 0, 1 }));
            server = s;
            Thread accept = new Thread(() -> acceptLoop(s), "fask-relay-accept");
            accept.setDaemon(true);
            accept.start();
        }
        if (pipes.isEmpty()) scheduleIdleCheck(idleCloseMs);
        return server.getLocalPort();
    }

    private void acceptLoop(ServerSocket s) {
        while (true) {
            Socket local;
            try {
                local = s.accept();
            } catch (IOException e) {
                return;
            }
            synchronized (this) {
                if (s != server || pipes.size() >= MAX_PIPES || now() < offlineUntil) {
                    closeQuietly(local);
                    continue;
                }
                Pipe pipe = new Pipe(local);
                pipes.add(pipe);
                if (idleCheck != null) idleCheck.cancel(false);
                idleCheck = null;
                pipe.start();
            }
        }
    }

    private void scheduleIdleCheck(long delayMs) {
        if (idleCheck != null) idleCheck.cancel(false);
        idleCheck = TIMERS.schedule(this::idleCheck, delayMs, TimeUnit.MILLISECONDS);
    }

    private synchronized void idleCheck() {
        idleCheck = null;
        if (!pipes.isEmpty()) return;
        long idle = now() - lastResolveAt;
        if (idle < idleCloseMs) {
            scheduleIdleCheck(idleCloseMs - idle);
            return;
        }
        closeQuietly(server);
        server = null;
    }

    private synchronized void removed(Pipe pipe) {
        if (pipes.remove(pipe) && pipes.isEmpty()) scheduleIdleCheck(idleCloseMs);
    }

    private synchronized void hostOffline() {
        offlineUntil = now() + offlineBackoffMs;
    }

    synchronized int activePipes() {
        return pipes.size();
    }

    synchronized boolean listening() {
        return server != null && !server.isClosed();
    }

    static int liveThreads() {
        int n = 0;
        for (Thread t : Thread.getAllStackTraces().keySet()) {
            String name = t.getName();
            if (t.isAlive() && (name.startsWith("fask-relay-up-") || name.startsWith("fask-relay-down-"))) n++;
        }
        return n;
    }

    /** One local connection ⇄ one relay WebSocket; buffering in each direction is bounded by WINDOW. */
    private final class Pipe extends WebSocketListener {
        private final int id = PIPE_IDS.incrementAndGet();
        private final Socket local;
        private final RelayFraming.Window window = new RelayFraming.Window();
        private final LinkedBlockingQueue<ByteString> inbound = new LinkedBlockingQueue<>();
        private final AtomicLong receivedUnacked = new AtomicLong();
        private final AtomicBoolean closed = new AtomicBoolean();
        private final AtomicBoolean localEnded = new AtomicBoolean();
        private final AtomicBoolean remoteEnded = new AtomicBoolean();
        private volatile WebSocket ws;
        private volatile boolean ready;
        private volatile ScheduledFuture<?> readyTimeout;

        Pipe(Socket local) {
            this.local = local;
        }

        void start() {
            try {
                local.setTcpNoDelay(true);
                // Keep kernel buffering small so credit tracks what the local client actually read.
                local.setSendBufferSize(RelayFraming.CHUNK);
            } catch (IOException ignored) {
                // Best effort.
            }
            readyTimeout = TIMERS.schedule(this::close, readyTimeoutMs, TimeUnit.MILLISECONDS);
            WebSocket socket = CLIENT.newWebSocket(
                new Request.Builder().url(relayUrl + "/v1/connect/" + room).build(), this);
            ws = socket;
            // close() may have run before the socket existed.
            if (closed.get()) socket.cancel();
        }

        @Override
        public void onOpen(WebSocket socket, Response response) {
            ws = socket;
        }

        private void violate(WebSocket socket, String reason) {
            socket.close(4400, reason);
            close();
        }

        @Override
        public void onMessage(WebSocket socket, String text) {
            if (closed.get()) return;
            if (ready || !"ready".equals(text)) {
                violate(socket, "protocol");
                return;
            }
            ready = true;
            ScheduledFuture<?> timeout = readyTimeout;
            if (timeout != null) timeout.cancel(false);
            startThread("fask-relay-up-" + id, this::uplink);
            startThread("fask-relay-down-" + id, this::downlink);
        }

        @Override
        public void onMessage(WebSocket socket, ByteString bytes) {
            if (closed.get()) return;
            RelayFraming.Frame frame;
            try {
                if (!ready) throw new IOException("relay protocol");
                frame = RelayFraming.parse(bytes);
            } catch (IOException e) {
                violate(socket, "protocol");
                return;
            }
            if (frame.type == RelayFraming.DATA) {
                if (receivedUnacked.addAndGet(frame.payload.size()) > RelayFraming.WINDOW) {
                    violate(socket, "window");
                    return;
                }
                inbound.offer(frame.payload);
                return;
            }
            try {
                window.release(frame.credit);
            } catch (IOException e) {
                violate(socket, "protocol");
            }
        }

        @Override
        public void onClosing(WebSocket socket, int code, String reason) {
            socket.close(1000, null);
            // Nothing more can be sent; unblock an uplink waiting for credit that will never come.
            window.close();
            // Deliver everything already received before ending the local stream.
            if (ready) inbound.offer(END);
            else close();
        }

        @Override
        public void onClosed(WebSocket socket, int code, String reason) {
            if (!ready) close();
        }

        @Override
        public void onFailure(WebSocket socket, Throwable t, Response response) {
            if (response != null && response.code() == 503) hostOffline();
            close();
        }

        private void startThread(String name, Runnable body) {
            Thread t = new Thread(body, name);
            t.setDaemon(true);
            t.start();
        }

        /**
         * Keeps reading the local socket until it ends even once nothing can be forwarded: unread
         * input would turn the final close into a reset that discards what the client has not read.
         */
        private void uplink() {
            byte[] buf = new byte[RelayFraming.CHUNK];
            boolean forwarding = true;
            try {
                InputStream in = local.getInputStream();
                int n;
                while ((n = in.read(buf)) >= 0) {
                    if (!forwarding || n == 0) continue;
                    try {
                        window.acquire(n);
                    } catch (IOException windowClosed) {
                        forwarding = false;
                        continue;
                    }
                    forwarding = ws.send(RelayFraming.data(buf, 0, n));
                }
            } catch (IOException | InterruptedException e) {
                close();
                return;
            }
            ws.close(1000, null);
            localEnded.set(true);
            if (remoteEnded.get()) close();
        }

        private void downlink() {
            long credit = 0;
            try {
                OutputStream out = local.getOutputStream();
                while (true) {
                    ByteString chunk = inbound.take();
                    if (chunk == STOP) return;
                    if (chunk == END) break;
                    chunk.write(out);
                    credit += chunk.size();
                    if (credit >= RelayFraming.ACK_EVERY) {
                        receivedUnacked.addAndGet(-credit);
                        // Fails only once the socket is closing, when credit no longer matters.
                        ws.send(RelayFraming.ack((int) credit));
                        credit = 0;
                    }
                }
                local.shutdownOutput();
            } catch (IOException | InterruptedException e) {
                close();
                return;
            }
            remoteEnded.set(true);
            if (localEnded.get()) close();
            // A client that never closes its side still gets released.
            else TIMERS.schedule(this::close, 2000, TimeUnit.MILLISECONDS);
        }

        void close() {
            if (!closed.compareAndSet(false, true)) return;
            ScheduledFuture<?> timeout = readyTimeout;
            if (timeout != null) timeout.cancel(false);
            window.close();
            inbound.clear();
            inbound.offer(STOP);
            closeQuietly(local);
            WebSocket socket = ws;
            if (socket != null) {
                // Before ready there is nothing to say; afterwards end with a close frame.
                if (ready) socket.close(1000, null);
                else socket.cancel();
            }
            removed(this);
        }
    }
}
