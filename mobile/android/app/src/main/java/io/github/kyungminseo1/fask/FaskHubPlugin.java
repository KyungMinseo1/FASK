package io.github.kyungminseo1.fask;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.util.Log;
import androidx.activity.result.ActivityResult;
import java.io.IOException;
import java.io.OutputStream;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "FaskHub")
public class FaskHubPlugin extends Plugin {
    private static final String TAG = "FaskHub";
    private final HubHttpClient client = new HubHttpClient();

    @PluginMethod
    public void request(PluginCall call) {
        String url = resolved(call);
        String method = call.getString("method", "GET");
        String body = call.getString("body");
        String fingerprint = call.getString("fingerprint");
        String token = call.getString("token");
        Double timeout = call.getDouble("timeoutMs");
        if (url == null || fingerprint == null || token == null || timeout == null) {
            call.reject("NETWORK", "NETWORK");
            return;
        }
        client.request(url, method, body, fingerprint, token, timeout.longValue(), new HubHttpClient.RequestCallback() {
            @Override
            public void onResponse(int status, String body) {
                JSObject ret = new JSObject();
                ret.put("status", status);
                ret.put("body", body);
                call.resolve(ret);
            }

            @Override
            public void onFailure(String code) {
                Log.w(TAG, "request failed: " + code);
                call.reject(code, code);
            }
        });
    }

    @PluginMethod
    public void pairRequest(PluginCall call) {
        String url = resolved(call);
        String body = call.getString("body");
        Double timeout = call.getDouble("timeoutMs");
        if (url == null || body == null || timeout == null) {
            call.reject("NETWORK", "NETWORK");
            return;
        }
        client.pairRequest(url, body, timeout.longValue(), new HubHttpClient.PairCallback() {
            @Override
            public void onResponse(int status, String body, String fingerprint) {
                JSObject ret = new JSObject();
                ret.put("status", status);
                ret.put("body", body);
                ret.put("fingerprint", fingerprint);
                call.resolve(ret);
            }

            @Override
            public void onFailure(String code) {
                Log.w(TAG, "pair request failed: " + code);
                call.reject(code, code);
            }
        });
    }

    @PluginMethod
    public void openEvents(PluginCall call) {
        String id = call.getString("id");
        String url = resolved(call);
        String fingerprint = call.getString("fingerprint");
        String token = call.getString("token");
        if (id == null || url == null || fingerprint == null || token == null) {
            call.reject("NETWORK", "NETWORK");
            return;
        }
        client.openEvents(id, url, fingerprint, token, new EventStream.Listener() {
            @Override
            public void onEvent(String event, String data) {
                JSObject o = new JSObject();
                o.put("id", id);
                o.put("event", event);
                o.put("data", data);
                notifyListeners("hubEvent", o);
            }

            @Override
            public void onClosed(String code) {
                Log.i(TAG, "event stream closed: " + code);
                JSObject o = new JSObject();
                o.put("id", id);
                o.put("error", code);
                notifyListeners("hubClosed", o);
            }
        }, new HubHttpClient.OpenCallback() {
            @Override
            public void onOpen() {
                call.resolve();
            }

            @Override
            public void onFailure(String code) {
                Log.w(TAG, "event stream open failed: " + code);
                call.reject(code, code);
            }
        });
    }

    @PluginMethod
    public void closeEvents(PluginCall call) {
        String id = call.getString("id");
        if (id != null) client.closeEvents(id);
        call.resolve();
    }

    /** Storage Access Framework picker: the user chooses where the file goes, so no storage permission is needed. */
    @PluginMethod
    public void saveDocument(PluginCall call) {
        String name = call.getString("fileName");
        String mime = call.getString("mimeType");
        if (name == null || mime == null || call.getString("data") == null) {
            call.reject("INVALID", "INVALID");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime)
            .putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, intent, "saveDocumentResult");
    }

    @ActivityCallback
    private void saveDocumentResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Uri uri = result.getResultCode() == Activity.RESULT_OK && result.getData() != null ? result.getData().getData() : null;
        if (uri == null) {
            call.resolve(new JSObject().put("saved", false));
            return;
        }
        String data = call.getString("data");
        ContentResolver resolver = getContext().getContentResolver();
        // The picker already created the file; a failed write removes it.
        Runnable discard = () -> {
            try {
                DocumentsContract.deleteDocument(resolver, uri);
            } catch (Exception ignored) {
                // Best effort: some providers do not support deletion.
            }
        };
        if (data == null) {
            discard.run();
            call.reject("파일을 저장하지 못했습니다.", "WRITE_FAILED");
            return;
        }
        getBridge().execute(() -> {
            try (OutputStream out = resolver.openOutputStream(uri, "wt")) {
                if (out == null) throw new IOException("no stream");
                out.write(Base64.decode(data, Base64.DEFAULT));
                call.resolve(new JSObject().put("saved", true));
            } catch (IOException | IllegalArgumentException | SecurityException e) {
                Log.w(TAG, "saveDocument failed", e);
                discard.run();
                call.reject("파일을 저장하지 못했습니다.", "WRITE_FAILED");
            }
        });
    }

    /** The call's hub URL with the relay pseudo-address mapped to the loopback tunnel; null rejects NETWORK. */
    private static String resolved(PluginCall call) {
        try {
            return RelayTunnel.resolve(call.getString("url"), call.getString("relayUrl"), call.getString("relayRoom"));
        } catch (IOException e) {
            return null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        client.close();
    }
}
