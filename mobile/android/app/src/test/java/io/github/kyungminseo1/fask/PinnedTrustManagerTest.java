package io.github.kyungminseo1.fask;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.net.ServerSocket;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import okhttp3.tls.HeldCertificate;
import org.junit.Test;

public class PinnedTrustManagerTest {
    private static Response get(OkHttpClient c, String url) throws IOException {
        return c.newCall(new Request.Builder().url(url).header("Authorization", "Bearer tok").build()).execute();
    }

    private static IOException expectFailure(OkHttpClient c, String url) {
        try (Response r = get(c, url)) {
            fail("expected failure, got " + r.code());
            return null;
        } catch (IOException e) {
            return e;
        }
    }

    @Test
    public void correctPinSucceedsAndSendsToken() throws Exception {
        HeldCertificate a = TestCerts.leaf("a");
        try (MockWebServer s = TestCerts.tlsServer(a)) {
            s.enqueue(new MockResponse().setBody("ok"));
            s.start(TestCerts.loopback(), 0);
            try (Response r = get(PinnedTrustManager.client(TestCerts.pin(a), 5000), s.url("/x").toString())) {
                assertEquals(200, r.code());
            }
            RecordedRequest rr = s.takeRequest();
            assertEquals("Bearer tok", rr.getHeader("Authorization"));
        }
    }

    @Test
    public void wrongCertIsPinMismatchAndTokenNeverSent() throws Exception {
        HeldCertificate a = TestCerts.leaf("a");
        HeldCertificate b = TestCerts.leaf("b");
        try (MockWebServer s = TestCerts.tlsServer(b)) {
            s.enqueue(new MockResponse().setBody("ok"));
            s.start(TestCerts.loopback(), 0);
            IOException e = expectFailure(PinnedTrustManager.client(TestCerts.pin(a), 5000), s.url("/").toString());
            assertEquals("PIN_MISMATCH", HubErrors.classify(e));
            assertEquals(0, s.getRequestCount());
        }
    }

    @Test
    public void certRotationOnSamePortIsRejected() throws Exception {
        HeldCertificate a = TestCerts.leaf("a");
        HeldCertificate b = TestCerts.leaf("b");
        OkHttpClient c = PinnedTrustManager.client(TestCerts.pin(a), 5000);
        try (MockWebServer server = TestCerts.tlsServer(a)) {
            server.enqueue(new MockResponse().setBody("ok"));
            server.start(TestCerts.loopback(), 0);
            String url = server.url("/").toString();
            try (Response r = get(c, url)) {
                assertEquals(200, r.code());
            }
            RecordedRequest first = server.takeRequest(1, java.util.concurrent.TimeUnit.SECONDS);
            assertNotNull(first);
            assertEquals("Bearer tok", first.getHeader("Authorization"));

            // Keep the listener and URL: rebinding a just-closed port can fail on
            // Linux. Force a new TLS connection, then rotate its certificate.
            c.connectionPool().evictAll();
            TestCerts.useCertificate(server, b);
            // Enqueue after rotation so the server observes it before the next handshake.
            server.enqueue(new MockResponse().setBody("ok"));
            IOException e = expectFailure(c, url);
            assertEquals("PIN_MISMATCH", HubErrors.classify(e));
            assertEquals(1, server.getRequestCount());
            assertNull(server.takeRequest(100, java.util.concurrent.TimeUnit.MILLISECONDS));
        } finally {
            c.connectionPool().evictAll();
            c.dispatcher().executorService().shutdownNow();
        }
    }

    @Test
    public void onlyLeafIsPinnedNotCa() throws Exception {
        HeldCertificate ca = new HeldCertificate.Builder().commonName("ca").ecdsa256().certificateAuthority(0).build();
        HeldCertificate leaf = new HeldCertificate.Builder().commonName("c").ecdsa256()
            .addSubjectAlternativeName("localhost").signedBy(ca).build();
        try (MockWebServer s = TestCerts.tlsServer(leaf, ca)) {
            s.enqueue(new MockResponse().setBody("ok"));
            s.start(TestCerts.loopback(), 0);
            String url = s.url("/").toString();
            IOException e = expectFailure(PinnedTrustManager.client(TestCerts.pin(ca), 5000), url);
            assertEquals("PIN_MISMATCH", HubErrors.classify(e));
            assertEquals(0, s.getRequestCount());
            try (Response r = get(PinnedTrustManager.client(TestCerts.pin(leaf), 5000), url)) {
                assertEquals(200, r.code());
            }
        }
    }

    @Test
    public void plaintextServerIsNetworkAndTokenNotLeaked() throws Exception {
        HeldCertificate a = TestCerts.leaf("a");
        try (MockWebServer s = new MockWebServer()) {
            s.enqueue(new MockResponse().setBody("ok"));
            s.start(TestCerts.loopback(), 0);
            String url = "https://127.0.0.1:" + s.getPort() + "/";
            IOException e = expectFailure(PinnedTrustManager.client(TestCerts.pin(a), 3000), url);
            assertEquals("NETWORK", HubErrors.classify(e));
            for (int i = 0; i < s.getRequestCount(); i++) {
                RecordedRequest rr = s.takeRequest(1, java.util.concurrent.TimeUnit.SECONDS);
                if (rr == null) break;
                String auth = rr.getHeader("Authorization");
                assertFalse(auth != null && auth.contains("Bearer tok"));
                assertFalse(rr.getBody().readUtf8().contains("Bearer tok"));
            }
        }
    }

    @Test
    public void closedPortIsNetwork() throws Exception {
        int port;
        try (ServerSocket ss = new ServerSocket(0, 1, TestCerts.loopback())) {
            port = ss.getLocalPort();
        }
        IOException e = expectFailure(PinnedTrustManager.client("x", 3000), "https://127.0.0.1:" + port + "/");
        assertEquals("NETWORK", HubErrors.classify(e));
    }

    @Test
    public void redirectIsReturnedAsIs() throws Exception {
        HeldCertificate a = TestCerts.leaf("a");
        try (MockWebServer s = TestCerts.tlsServer(a)) {
            s.enqueue(new MockResponse().setResponseCode(302).setHeader("Location", "https://example.com/"));
            s.start(TestCerts.loopback(), 0);
            try (Response r = get(PinnedTrustManager.client(TestCerts.pin(a), 5000), s.url("/").toString())) {
                assertEquals(302, r.code());
            }
            assertEquals(1, s.getRequestCount());
        }
    }

    @Test
    public void emptyChainAndClientTrustThrow() throws Exception {
        PinnedTrustManager tm = new PinnedTrustManager(TestCerts.pin(TestCerts.leaf("a")));
        try {
            tm.checkServerTrusted(new X509Certificate[0], "ECDHE_ECDSA");
            fail();
        } catch (CertificateException e) {
            assertEquals("FASK_PIN_MISMATCH", e.getMessage());
        }
        try {
            tm.checkServerTrusted(null, "ECDHE_ECDSA");
            fail();
        } catch (CertificateException e) {
            assertEquals("FASK_PIN_MISMATCH", e.getMessage());
        }
        try {
            tm.checkClientTrusted(new X509Certificate[] { TestCerts.leaf("a").certificate() }, "ECDHE_ECDSA");
            fail();
        } catch (CertificateException expected) {
            assertNotNull(expected);
        }
        assertEquals(0, tm.getAcceptedIssuers().length);
    }
}
