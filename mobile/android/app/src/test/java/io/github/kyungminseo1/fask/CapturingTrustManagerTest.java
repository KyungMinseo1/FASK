package io.github.kyungminseo1.fask;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.fail;

import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import okhttp3.tls.HeldCertificate;
import org.junit.Test;

public class CapturingTrustManagerTest {
    @Test
    public void acceptsAnyLeafAndRecordsItsFingerprint() throws Exception {
        HeldCertificate cert = TestCerts.leaf("hub");
        try (MockWebServer s = TestCerts.tlsServer(cert)) {
            s.enqueue(new MockResponse().setBody("ok"));
            s.start(TestCerts.loopback(), 0);
            CapturingTrustManager tm = new CapturingTrustManager();
            assertNull(tm.fingerprint());
            try (Response r = CapturingTrustManager.client(tm, 5000)
                .newCall(new Request.Builder().url(s.url("/pair/ke1")).build()).execute()) {
                assertEquals(200, r.code());
            }
            assertEquals(TestCerts.pin(cert), tm.fingerprint());
        }
    }

    @Test
    public void emptyChainAndClientTrustThrow() throws Exception {
        CapturingTrustManager tm = new CapturingTrustManager();
        try {
            tm.checkServerTrusted(new X509Certificate[0], "ECDHE_ECDSA");
            fail("empty chain accepted");
        } catch (CertificateException expected) {
            // rejected
        }
        try {
            tm.checkClientTrusted(new X509Certificate[] { TestCerts.leaf("c").certificate() }, "ECDHE_ECDSA");
            fail("client chain accepted");
        } catch (CertificateException expected) {
            // rejected
        }
    }

    @Test
    public void pairRequestPostsJsonWithoutBearerAndReportsFingerprint() throws Exception {
        HeldCertificate cert = TestCerts.leaf("hub");
        try (MockWebServer server = TestCerts.tlsServer(cert); HubHttpClient client = new HubHttpClient()) {
            server.enqueue(new MockResponse().setResponseCode(410).setBody("{\"error\":\"gone\"}"));
            server.start(TestCerts.loopback(), 0);
            BlockingQueue<String> results = new LinkedBlockingQueue<>();
            client.pairRequest(server.url("/pair/ke1").toString(), "{\"kind\":\"mobile\"}", 5000,
                new HubHttpClient.PairCallback() {
                    @Override public void onResponse(int status, String body, String fingerprint) {
                        results.add(status + ":" + body + ":" + fingerprint);
                    }
                    @Override public void onFailure(String code) { results.add("failure:" + code); }
                });

            assertEquals("410:{\"error\":\"gone\"}:" + TestCerts.pin(cert), results.poll(10, TimeUnit.SECONDS));
            RecordedRequest request = server.takeRequest(10, TimeUnit.SECONDS);
            assertNotNull(request);
            assertEquals("POST", request.getMethod());
            assertNull(request.getHeader("Authorization"));
            assertEquals("application/json; charset=utf-8", request.getHeader("Content-Type"));
            assertEquals("{\"kind\":\"mobile\"}", request.getBody().readUtf8());
        }
    }
}
