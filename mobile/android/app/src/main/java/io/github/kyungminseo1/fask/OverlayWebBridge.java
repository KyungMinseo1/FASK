package io.github.kyungminseo1.fask;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.graphics.RectF;
import android.net.Uri;
import android.os.Handler;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Service-owned panel WebView and its message bridge. The page only names an address and an
 * allowlisted RPC; URL, certificate pin and bearer token are built here and never reach JS.
 */
final class OverlayWebBridge {
    interface Host {
        boolean live(long epoch);
        void stop(String code, String message);
        void capture(OverlayCaptureController.Callback callback);
    }

    static final String ORIGIN = "https://appassets.androidplatform.net";
    static final String PAGE = ORIGIN + "/assets/public/overlay.html";
    static final String UPDATE_WEBVIEW = "Android System WebView를 업데이트해 주세요.";
    private static final String TAG = "FaskOverlay";
    private static final int MAX_BODY_BYTES = 40 * 1024 * 1024;
    static final Set<String> METHODS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "snapshot", "create", "rename", "remove", "update-question", "edit-concept", "merge-concept",
        "ask", "cancel", "turn-state", "refine", "attachment", "clear-attachment")));

    private final Context context;
    private final Handler main;
    private final OverlaySession session;
    private final long epoch;
    private final OverlayWindowController overlay;
    private final Host host;
    private final HubHttpClient http = new HubHttpClient();
    private final WebView web;
    private JavaScriptReplyProxy reply;
    private boolean closed;
    private boolean panelShown;
    private long captureRevision;
    private String stateKey = "";

    static boolean supported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER);
    }

    @SuppressLint("SetJavaScriptEnabled")
    OverlayWebBridge(Context context, Handler main, OverlaySession session, long epoch,
                     OverlayWindowController overlay, Host host) {
        this.context = context;
        this.main = main;
        this.session = session;
        this.epoch = epoch;
        this.overlay = overlay;
        this.host = host;
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(context))
            .build();
        web = new WebView(context);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setGeolocationEnabled(false);
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                // Only the bundled panel; everything else (remote, other asset roots) is refused.
                if (ORIGIN.equals(url.getScheme() + "://" + url.getHost())
                    && url.getPath() != null && url.getPath().startsWith("/assets/public/")) {
                    return assets.shouldInterceptRequest(url);
                }
                return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden",
                    Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (request.isForMainFrame() && ("https".equals(url.getScheme()) || "http".equals(url.getScheme()))
                    && !PAGE.equals(url.toString())) {
                    try {
                        context.startActivity(new Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    } catch (RuntimeException error) {
                        Log.w(TAG, "No browser for panel link");
                    }
                }
                return true;
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The Composer state is gone; never substitute a fresh panel silently.
                main.post(() -> host.stop("CLOSED", "질문 창이 비정상 종료되어 화면 질문을 종료했습니다."));
                return true;
            }
        });
        WebViewCompat.addWebMessageListener(web, "FaskOverlayBridge", Collections.singleton(ORIGIN),
            (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                if (!isMainFrame || !ORIGIN.equals(sourceOrigin.toString())) return;
                String data = message.getType() == WebMessageCompat.TYPE_STRING ? message.getData() : null;
                if (data != null) receive(data, replyProxy);
            });
        web.loadUrl(PAGE);
    }

    WebView view() { return web; }

    /** Called by the service whenever the overlay state changes on the main thread. */
    void onOverlayChanged() {
        if (closed) return;
        OverlayInkView ink = overlay.getInk();
        RectF region = ink.getRegion();
        String key = ink.getRevision() + ":" + region + ":" + overlay.getGeometry().epoch;
        if (!key.equals(stateKey)) {
            stateKey = key;
            captureRevision++;
        }
        boolean shown = overlay.getMode() == OverlayWindowController.Mode.PANEL;
        if (shown && !panelShown) push("panelShown", new JSONObject());
        panelShown = shown;
        push("overlayState", state());
    }

    void close() {
        if (closed) return;
        push("sessionInvalidated", new JSONObject());
        closed = true;
        reply = null;
        try { http.close(); } catch (RuntimeException ignored) { }
        try {
            web.stopLoading();
            if (web.getParent() instanceof android.view.ViewGroup) ((android.view.ViewGroup) web.getParent()).removeView(web);
            web.destroy();
        } catch (RuntimeException ignored) { }
    }

    private JSONObject state() {
        JSONObject o = new JSONObject();
        try {
            OverlayInkView ink = overlay.getInk();
            o.put("hasInk", ink.hasInk());
            o.put("inkRevision", ink.getRevision());
            o.put("captureRevision", captureRevision);
            o.put("mode", overlay.getMode().name());
            RectF region = ink.getRegion();
            if (region != null) o.put("region", new JSONObject()
                .put("width", Math.round(region.width())).put("height", Math.round(region.height())));
        } catch (JSONException ignored) { }
        return o;
    }

    private void receive(String data, JavaScriptReplyProxy proxy) {
        if (closed) return;
        JSONObject message;
        String id;
        String op;
        JSONObject payload;
        try {
            message = new JSONObject(data);
            if (message.optInt("v") != 1) return;
            id = message.getString("id");
            op = message.getString("op");
            payload = message.optJSONObject("payload");
            if (payload == null) payload = new JSONObject();
        } catch (JSONException error) {
            return;
        }
        reply = proxy;
        if (!"bootstrap".equals(op) && !session.id.equals(message.optString("sessionId"))) {
            fail(id, "CLOSED", "화면 질문 세션이 바뀌었습니다.");
            return;
        }
        if (!host.live(epoch)) {
            fail(id, "CLOSED", OverlayCaptureController.CLOSED_MESSAGE);
            return;
        }
        try {
            handle(id, op, payload);
        } catch (JSONException | RuntimeException error) {
            fail(id, "INVALID", "잘못된 요청입니다.");
        }
    }

    private void handle(String id, String op, JSONObject p) throws JSONException {
        switch (op) {
            case "bootstrap": {
                JSONObject identity = new JSONObject()
                    .put("addresses", new JSONArray(Arrays.asList(session.addresses)))
                    .put("port", session.port)
                    .put("fingerprint", session.fingerprint);
                JSONObject result = state()
                    .put("identity", identity)
                    .put("profileId", session.profileId)
                    .put("projectId", session.projectId)
                    .put("sessionId", session.id);
                if (session.activeQuestionId != null) result.put("questionId", session.activeQuestionId);
                ok(id, result);
                return;
            }
            case "request": request(id, p); return;
            case "openEvents": openEvents(id, p); return;
            case "closeEvents":
                http.closeEvents(p.getString("id"));
                ok(id, new JSONObject());
                return;
            case "selectRegion":
                overlay.setMode(OverlayWindowController.Mode.REGION);
                ok(id, new JSONObject().put("mode", overlay.getMode().name()));
                return;
            case "captureSelectedRegion":
                host.capture(new OverlayCaptureController.Callback() {
                    @Override public void onCaptured(String dataUrl, long inkRevision) {
                        main.post(() -> {
                            try { ok(id, new JSONObject().put("dataUrl", dataUrl).put("inkRevision", inkRevision)); }
                            catch (JSONException error) { fail(id, "CAPTURE", "캡처 결과를 전달하지 못했습니다."); }
                        });
                    }
                    @Override public void onFailure(String code, String message) {
                        main.post(() -> fail(id, code, message));
                    }
                });
                return;
            case "setInteractionState":
                overlay.setInteractionState(p.optBoolean("busy"), p.optBoolean("running"), p.optBoolean("unresolved"));
                ok(id, new JSONObject());
                return;
            case "setQuestion": {
                String question = p.isNull("questionId") ? null : p.getString("questionId");
                if (question != null && !question.matches("[A-Za-z0-9-]{1,100}")) throw new JSONException("questionId");
                session.activeQuestionId = question;
                ok(id, new JSONObject());
                return;
            }
            case "clearInk": {
                boolean cleared = overlay.getInk().clearInk(p.getLong("expectedRevision"));
                ok(id, new JSONObject().put("cleared", cleared));
                return;
            }
            case "setPanelVisible":
                if (p.getBoolean("visible")) overlay.showPanel();
                else overlay.hidePanel();
                ok(id, new JSONObject());
                return;
            case "stop":
                ok(id, new JSONObject());
                host.stop("CLOSED", "화면 질문을 종료했습니다.");
                return;
            default:
                fail(id, "INVALID", "지원하지 않는 요청입니다.");
        }
    }

    private String address(JSONObject p) throws JSONException {
        String address = p.getString("address");
        if (!Arrays.asList(session.addresses).contains(address)) throw new JSONException("address");
        return address;
    }

    private void request(String id, JSONObject p) throws JSONException {
        String address = address(p);
        String method = p.getString("method");
        String path = p.getString("path");
        boolean allowed = ("GET".equals(method) && "/health".equals(path))
            || ("POST".equals(method) && path.startsWith("/rpc/") && METHODS.contains(path.substring(5)));
        if (!allowed) throw new JSONException("path");
        String body = p.has("body") && !p.isNull("body") ? p.getString("body") : null;
        if (body != null && body.getBytes(StandardCharsets.UTF_8).length > MAX_BODY_BYTES) {
            fail(id, "INVALID", "요청이 너무 큽니다.");
            return;
        }
        long timeout = p.getLong("timeoutMs");
        if (timeout < 1 || timeout > 120000) throw new JSONException("timeout");
        String token = session.token();
        if (token == null) {
            fail(id, "CLOSED", OverlayCaptureController.CLOSED_MESSAGE);
            return;
        }
        http.request("https://" + address + ":" + session.port + path, method, body, session.fingerprint, token, timeout,
            new HubHttpClient.RequestCallback() {
                @Override public void onResponse(int status, String response) {
                    main.post(() -> {
                        if (status == 401) {
                            revoked();
                            fail(id, "UNAUTHORIZED", "UNAUTHORIZED");
                            return;
                        }
                        try { ok(id, new JSONObject().put("status", status).put("body", response)); }
                        catch (JSONException error) { fail(id, "NETWORK", "NETWORK"); }
                    });
                }
                @Override public void onFailure(String code) {
                    main.post(() -> {
                        if ("UNAUTHORIZED".equals(code)) revoked();
                        fail(id, code, code);
                    });
                }
            });
    }

    private void openEvents(String id, JSONObject p) throws JSONException {
        String stream = p.getString("id");
        if (!stream.matches("[A-Za-z0-9-]{1,100}")) throw new JSONException("id");
        String address = address(p);
        String token = session.token();
        if (token == null) {
            fail(id, "CLOSED", OverlayCaptureController.CLOSED_MESSAGE);
            return;
        }
        http.openEvents(stream, "https://" + address + ":" + session.port + "/events", session.fingerprint, token,
            new EventStream.Listener() {
                @Override public void onEvent(String event, String data) {
                    main.post(() -> {
                        try { push("hubEvent", new JSONObject().put("id", stream).put("event", event).put("data", data)); }
                        catch (JSONException ignored) { }
                    });
                }
                @Override public void onClosed(String code) {
                    main.post(() -> {
                        if ("UNAUTHORIZED".equals(code)) revoked();
                        try { push("hubClosed", new JSONObject().put("id", stream).put("error", code)); }
                        catch (JSONException ignored) { }
                    });
                }
            },
            new HubHttpClient.OpenCallback() {
                @Override public void onOpen() { main.post(() -> ok(id, new JSONObject())); }
                @Override public void onFailure(String code) {
                    main.post(() -> {
                        if ("UNAUTHORIZED".equals(code)) revoked();
                        fail(id, code, code);
                    });
                }
            });
    }

    /** A revoked token ends this session; the app deletes its pairing when it next consumes the mark. */
    private void revoked() {
        if (closed) return;
        OverlaySession.revokedFingerprint = session.fingerprint;
        OverlayPlugin.notifyRevoked(session.fingerprint);
        host.stop("UNAUTHORIZED", "페어링이 해제되었습니다. 앱에서 다시 연결해 주세요.");
    }

    private void ok(String id, JSONObject result) {
        if (!host.live(epoch)) {
            fail(id, "CLOSED", OverlayCaptureController.CLOSED_MESSAGE);
            return;
        }
        try {
            send(new JSONObject().put("v", 1).put("id", id).put("sessionId", session.id).put("result", result));
        } catch (JSONException ignored) { }
    }

    private void fail(String id, String code, String message) {
        try {
            send(new JSONObject().put("v", 1).put("id", id).put("sessionId", session.id)
                .put("error", new JSONObject().put("code", code).put("message", message)));
        } catch (JSONException ignored) { }
    }

    private void push(String event, JSONObject payload) {
        try {
            send(new JSONObject().put("v", 1).put("sessionId", session.id).put("event", event).put("payload", payload));
        } catch (JSONException ignored) { }
    }

    private void send(JSONObject message) {
        JavaScriptReplyProxy proxy = reply;
        if (closed || proxy == null) return;
        try { proxy.postMessage(message.toString()); }
        catch (RuntimeException error) { Log.w(TAG, "Panel message dropped"); }
    }
}
