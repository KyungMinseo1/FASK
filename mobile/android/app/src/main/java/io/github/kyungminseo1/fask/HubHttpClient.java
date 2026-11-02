package io.github.kyungminseo1.fask;

import java.io.IOException;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/** Activity-independent pinned hub transport. Each owner has its own request and stream lifetime. */
public final class HubHttpClient implements AutoCloseable {
    public interface RequestCallback {
        void onResponse(int status, String body);
        void onFailure(String code);
    }

    public interface OpenCallback {
        void onOpen();
        void onFailure(String code);
    }

    public interface PairCallback {
        void onResponse(int status, String body, String fingerprint);
        void onFailure(String code);
    }

    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");

    // Dispatch under the same lock as close so no callback can begin after close returns.
    private final Object lock = new Object();
    private final Set<Call> requests = new HashSet<>();
    private final Map<String, StreamState> streams = new HashMap<>();
    private boolean closed;

    private static final class StreamState {
        final EventStream.Listener listener;
        final OpenCallback callback;
        EventStream stream;
        boolean opening = true;

        StreamState(EventStream.Listener listener, OpenCallback callback) {
            this.listener = listener;
            this.callback = callback;
        }
    }

    public void request(String url, String method, String body, String fingerprint, String token,
                        long timeoutMs, RequestCallback callback) {
        synchronized (lock) {
            if (closed) return;
        }
        long timeout = Math.max(1L, timeoutMs);
        OkHttpClient client = PinnedTrustManager.client(fingerprint, timeout)
            .newBuilder()
            .callTimeout(timeout, TimeUnit.MILLISECONDS)
            .build();
        Request request;
        try {
            String m = method.toUpperCase(Locale.ROOT);
            RequestBody rb = null;
            if (body != null || "POST".equals(m) || "PUT".equals(m) || "PATCH".equals(m)) {
                rb = RequestBody.create(body == null ? "" : body, JSON);
            }
            request = new Request.Builder()
                .url(url)
                .header("Authorization", "Bearer " + token)
                .method(m, rb)
                .build();
        } catch (IllegalArgumentException e) {
            synchronized (lock) {
                if (!closed) callback.onFailure("NETWORK");
            }
            return;
        }
        Call call = client.newCall(request);
        synchronized (lock) {
            if (closed) {
                call.cancel();
                return;
            }
            requests.add(call);
            call.enqueue(new Callback() {
                @Override
                public void onFailure(Call c, IOException e) {
                    requestFailed(c, HubErrors.classify(e), callback);
                }

                @Override
                public void onResponse(Call c, Response r) {
                    int status;
                    String body;
                    try (Response response = r) {
                        status = response.code();
                        ResponseBody b = response.body();
                        body = b == null ? "" : b.string();
                    } catch (IOException e) {
                        requestFailed(c, HubErrors.classify(e), callback);
                        return;
                    }
                    synchronized (lock) {
                        if (!closed && requests.remove(c)) callback.onResponse(status, body);
                    }
                }
            });
        }
    }

    private void requestFailed(Call call, String code, RequestCallback callback) {
        synchronized (lock) {
            if (!closed && requests.remove(call)) callback.onFailure(code);
        }
    }

    /** Unpinned JSON POST for code pairing: no Authorization header; reports the leaf fingerprint. */
    public void pairRequest(String url, String body, long timeoutMs, PairCallback callback) {
        synchronized (lock) {
            if (closed) return;
        }
        CapturingTrustManager tm = new CapturingTrustManager();
        OkHttpClient client = CapturingTrustManager.client(tm, Math.max(1L, timeoutMs));
        Request request;
        try {
            request = new Request.Builder()
                .url(url)
                .post(RequestBody.create(body == null ? "" : body, JSON))
                .build();
        } catch (IllegalArgumentException e) {
            synchronized (lock) {
                if (!closed) callback.onFailure("NETWORK");
            }
            return;
        }
        Call call = client.newCall(request);
        synchronized (lock) {
            if (closed) {
                call.cancel();
                return;
            }
            requests.add(call);
            call.enqueue(new Callback() {
                @Override
                public void onFailure(Call c, IOException e) {
                    pairFailed(c, HubErrors.classify(e), callback);
                }

                @Override
                public void onResponse(Call c, Response r) {
                    int status;
                    String text;
                    try (Response response = r) {
                        status = response.code();
                        ResponseBody b = response.body();
                        text = b == null ? "" : b.string();
                    } catch (IOException e) {
                        pairFailed(c, HubErrors.classify(e), callback);
                        return;
                    }
                    String fingerprint = tm.fingerprint();
                    if (fingerprint == null) {
                        pairFailed(c, "NETWORK", callback);
                        return;
                    }
                    synchronized (lock) {
                        if (!closed && requests.remove(c)) callback.onResponse(status, text, fingerprint);
                    }
                }
            });
        }
    }

    private void pairFailed(Call call, String code, PairCallback callback) {
        synchronized (lock) {
            if (!closed && requests.remove(call)) callback.onFailure(code);
        }
    }

    public void openEvents(String id, String url, String fingerprint, String token,
                           EventStream.Listener listener, OpenCallback callback) {
        synchronized (lock) {
            if (closed) return;
            StreamState state = new StreamState(listener, callback);
            StreamState previous = streams.put(id, state);
            if (previous != null) {
                if (previous.stream != null) previous.stream.cancel();
                if (previous.opening) previous.callback.onFailure("NETWORK");
            }
            // A replacement callback may itself close the client or replace this ID.
            if (!isCurrent(id, state)) return;
            OkHttpClient client = PinnedTrustManager.client(fingerprint, 60000);
            try {
                state.stream = EventStream.open(client, url, token, new EventStream.Listener() {
                    @Override
                    public void onEvent(String event, String data) {
                        synchronized (lock) {
                            if (isCurrent(id, state) && !state.opening) state.listener.onEvent(event, data);
                        }
                    }

                    @Override
                    public void onClosed(String code) {
                        synchronized (lock) {
                            if (!isCurrent(id, state)) return;
                            streams.remove(id);
                            state.listener.onClosed(code);
                        }
                    }
                }, new EventStream.Opened() {
                    @Override
                    public void onOpen(EventStream stream) {
                        synchronized (lock) {
                            if (!isCurrent(id, state)) {
                                stream.cancel();
                                return;
                            }
                            state.stream = stream;
                            state.opening = false;
                            state.callback.onOpen();
                        }
                    }

                    @Override
                    public void onFailure(String code) {
                        synchronized (lock) {
                            if (!isCurrent(id, state)) return;
                            streams.remove(id);
                            state.callback.onFailure(code);
                        }
                    }
                });
            } catch (IllegalArgumentException e) {
                streams.remove(id);
                callback.onFailure("NETWORK");
            }
        }
    }

    private boolean isCurrent(String id, StreamState state) {
        return !closed && streams.get(id) == state;
    }

    /** Explicitly closing a pending open keeps the plugin's existing NETWORK rejection. */
    public void closeEvents(String id) {
        synchronized (lock) {
            StreamState state = streams.remove(id);
            if (state == null) return;
            if (state.stream != null) state.stream.cancel();
            if (!closed && state.opening) state.callback.onFailure("NETWORK");
        }
    }

    /** Cancels all work without notifying callbacks, including calls made after close. */
    @Override
    public void close() {
        synchronized (lock) {
            if (closed) return;
            closed = true;
            for (Call call : requests) call.cancel();
            requests.clear();
            for (StreamState state : streams.values()) {
                if (state.stream != null) state.stream.cancel();
            }
            streams.clear();
        }
    }
}
