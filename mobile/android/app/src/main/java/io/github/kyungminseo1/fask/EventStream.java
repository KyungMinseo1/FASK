package io.github.kyungminseo1.fask;

import java.io.IOException;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSource;

/** Minimal SSE client over a pinned OkHttp client. No callbacks fire after {@link #cancel()}. */
public final class EventStream {
    public interface Listener {
        void onEvent(String event, String data);
        void onClosed(String code);
    }

    public interface Opened {
        void onOpen(EventStream s);
        void onFailure(String code);
    }

    private final Listener listener;
    private final Opened opened;
    private volatile boolean cancelled;
    private volatile Call call;
    private volatile Response response;

    private EventStream(Listener l, Opened o) {
        this.listener = l;
        this.opened = o;
    }

    public static EventStream open(OkHttpClient client, String url, String token, Listener l, Opened o) {
        EventStream s = new EventStream(l, o);
        Request req = new Request.Builder()
            .url(url)
            .header("Authorization", "Bearer " + token)
            .header("Accept", "text/event-stream")
            .get()
            .build();
        s.call = client.newCall(req);
        s.call.enqueue(new Callback() {
            @Override
            public void onFailure(Call c, IOException e) {
                if (!s.cancelled) o.onFailure(HubErrors.classify(e));
            }

            @Override
            public void onResponse(Call c, Response r) {
                s.response = r;
                s.run(r);
            }
        });
        return s;
    }

    public void cancel() {
        cancelled = true;
        Call c = call;
        if (c != null) c.cancel();
        Response r = response;
        if (r != null) {
            try {
                r.close();
            } catch (RuntimeException ignored) {
                // closing concurrently with reader thread
            }
        }
    }

    private void run(Response r) {
        try (Response resp = r) {
            if (cancelled) return;
            if (resp.code() == 401) {
                opened.onFailure("UNAUTHORIZED");
                return;
            }
            String ct = resp.header("Content-Type", "");
            ResponseBody body = resp.body();
            if (resp.code() != 200 || ct == null || !ct.startsWith("text/event-stream") || body == null) {
                opened.onFailure("NETWORK");
                return;
            }
            BufferedSource src = body.source();
            String first;
            try {
                do {
                    first = src.readUtf8Line();
                } while (first != null && first.isEmpty());
            } catch (IOException e) {
                if (!cancelled) opened.onFailure(HubErrors.classify(e));
                return;
            }
            if (cancelled) return;
            if (!": connected".equals(first)) {
                opened.onFailure("NETWORK");
                return;
            }
            opened.onOpen(this);
            String code = "NETWORK";
            try {
                readEvents(src);
            } catch (IOException e) {
                code = HubErrors.classify(e);
            }
            if (!cancelled) listener.onClosed(code);
        }
    }

    private void readEvents(BufferedSource src) throws IOException {
        String event = null;
        StringBuilder data = null;
        String line;
        while (!cancelled && (line = src.readUtf8Line()) != null) {
            if (line.isEmpty()) {
                if (data != null && !cancelled) {
                    listener.onEvent(event == null ? "message" : event, data.toString());
                }
                event = null;
                data = null;
                continue;
            }
            if (line.startsWith(":")) continue;
            int colon = line.indexOf(':');
            String field = colon < 0 ? line : line.substring(0, colon);
            String value = colon < 0 ? "" : line.substring(colon + 1);
            if (value.startsWith(" ")) value = value.substring(1);
            if ("event".equals(field)) {
                event = value;
            } else if ("data".equals(field)) {
                if (data == null) data = new StringBuilder(value);
                else data.append('\n').append(value);
            }
        }
    }
}
