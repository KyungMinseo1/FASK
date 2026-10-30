package io.github.kyungminseo1.fask;

import android.util.Log;
import java.io.IOException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
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
