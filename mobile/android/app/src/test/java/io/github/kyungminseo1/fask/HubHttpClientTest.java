package io.github.kyungminseo1.fask;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import okhttp3.mockwebserver.Dispatcher;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import okhttp3.tls.HeldCertificate;
import org.junit.Test;

public class HubHttpClientTest {
    private static final class Rec implements HubHttpClient.RequestCallback, HubHttpClient.OpenCallback, EventStream.Listener {
        private final BlockingQueue<String> callbacks = new LinkedBlockingQueue<>();

        @Override public void onResponse(int status, String body) { callbacks.add("response:" + status + ":" + body); }
        @Override public void onFailure(String code) { callbacks.add("failure:" + code); }
        @Override public void onOpen() { callbacks.add("open"); }
        @Override public void onEvent(String event, String data) { callbacks.add("event:" + event + ":" + data); }
        @Override public void onClosed(String code) { callbacks.add("closed:" + code); }

        String next() throws InterruptedException {
            return callbacks.poll(10, TimeUnit.SECONDS);
        }

        String none() throws InterruptedException {
            return callbacks.poll(500, TimeUnit.MILLISECONDS);
        }
    }

    /** Holds responses until the test has closed or replaced the in-flight operation. */
    private static final class GatedResponse extends Dispatcher implements AutoCloseable {
        private final CountDownLatch entered;
        private final CountDownLatch release = new CountDownLatch(1);
        private final MockResponse response;

        GatedResponse(int requests, MockResponse response) {
            this.entered = new CountDownLatch(requests);
            this.response = response;
        }

        @Override
        public MockResponse dispatch(RecordedRequest request) throws InterruptedException {
            entered.countDown();
            if (!release.await(10, TimeUnit.SECONDS)) return new MockResponse().setResponseCode(500);
            return response.clone();
        }

        void awaitRequests() throws InterruptedException {
            assertTrue("request did not reach server", entered.await(10, TimeUnit.SECONDS));
        }

        @Override
        public void close() {
            release.countDown();
        }
    }

    private static MockResponse sse(String body) {
        return new MockResponse().setHeader("Content-Type", "text/event-stream").setBody(body);
    }

    @Test
    public void correctPinSendsBearerAndJsonAndReturnsResponse() throws Exception {
        HeldCertificate cert = TestCerts.leaf("hub");
        try (MockWebServer server = TestCerts.tlsServer(cert); HubHttpClient client = new HubHttpClient()) {
            server.enqueue(new MockResponse().setResponseCode(201).setBody("saved"));
            server.start(TestCerts.loopback(), 0);
            Rec rec = new Rec();
            client.request(server.url("/rpc/ask").toString(), "post", "{\"raw\":\"질문\"}",
                TestCerts.pin(cert), "secret", 5000, rec);

            assertEquals("response:201:saved", rec.next());
            RecordedRequest request = server.takeRequest(10, TimeUnit.SECONDS);
            assertNotNull(request);
            assertEquals("POST", request.getMethod());
            assertEquals("Bearer secret", request.getHeader("Authorization"));
            assertEquals("{\"raw\":\"질문\"}", request.getBody().readUtf8());
            assertNull(rec.none());
        }
    }

    @Test
    public void wrongPinRejectsBeforeBearerCanBeSent() throws Exception {
        HeldCertificate expected = TestCerts.leaf("paired");
        try (MockWebServer server = TestCerts.tlsServer(TestCerts.leaf("other")); HubHttpClient client = new HubHttpClient()) {
            server.enqueue(new MockResponse().setBody("must not be read"));
            server.start(TestCerts.loopback(), 0);
            Rec rec = new Rec();
            client.request(server.url("/rpc/ask").toString(), "POST", "{}", TestCerts.pin(expected), "secret", 5000, rec);

            assertEquals("failure:PIN_MISMATCH", rec.next());
            assertEquals(0, server.getRequestCount());
            assertNull(rec.none());
        }
    }

    @Test
    public void redirectIsReturnedWithoutFollowingIt() throws Exception {
        HeldCertificate cert = TestCerts.leaf("hub");
        try (MockWebServer server = TestCerts.tlsServer(cert); HubHttpClient client = new HubHttpClient()) {
            server.start(TestCerts.loopback(), 0);
            server.enqueue(new MockResponse().setResponseCode(302).setHeader("Location", server.url("/other")).setBody("redirect"));
            Rec rec = new Rec();
            client.request(server.url("/health").toString(), "GET", null, TestCerts.pin(cert), "secret", 5000, rec);

            assertEquals("response:302:redirect", rec.next());
            assertEquals(1, server.getRequestCount());
        }
    }

    @Test
    public void httpUnauthorizedRemainsAnHttpResponse() throws Exception {
        HeldCertificate cert = TestCerts.leaf("hub");
        try (MockWebServer server = TestCerts.tlsServer(cert); HubHttpClient client = new HubHttpClient()) {
            server.enqueue(new MockResponse().setResponseCode(401).setBody("revoked"));
            server.start(TestCerts.loopback(), 0);
            Rec rec = new Rec();
            client.request(server.url("/health").toString(), "GET", null, TestCerts.pin(cert), "secret", 5000, rec);

            assertEquals("response:401:revoked", rec.next());
            assertNull(rec.none());
        }
    }

    @Test
    public void eventsOpenAfterPreambleAndKeepBearerAuthentication() throws Exception {
        HeldCertificate cert = TestCerts.leaf("hub");
        try (MockWebServer server = TestCerts.tlsServer(cert); HubHttpClient client = new HubHttpClient()) {
            server.enqueue(sse(": connected\n\nevent: stream\ndata: {\"turnId\":\"turn-1\"}\n\n"));
            server.start(TestCerts.loopback(), 0);
            Rec rec = new Rec();
            client.openEvents("events", server.url("/events").toString(), TestCerts.pin(cert), "secret", rec, rec);

            assertEquals("open", rec.next());
            assertEquals("event:stream:{\"turnId\":\"turn-1\"}", rec.next());
            assertEquals("closed:NETWORK", rec.next());
            RecordedRequest request = server.takeRequest(10, TimeUnit.SECONDS);
            assertNotNull(request);
            assertEquals("Bearer secret", request.getHeader("Authorization"));
            assertEquals("text/event-stream", request.getHeader("Accept"));
            assertNull(rec.none());
        }
    }

    @Test
    public void unauthorizedEventHandshakeRejectsWithoutOpening() throws Exception {
        HeldCertificate cert = TestCerts.leaf("hub");
        try (MockWebServer server = TestCerts.tlsServer(cert); HubHttpClient client = new HubHttpClient()) {
            server.enqueue(new MockResponse().setResponseCode(401));
            server.start(TestCerts.loopback(), 0);
            Rec rec = new Rec();
            client.openEvents("events", server.url("/events").toString(), TestCerts.pin(cert), "secret", rec, rec);

            assertEquals("failure:UNAUTHORIZED", rec.next());
            assertNull(rec.none());
        }
    }

    @Test
    public void closeEventsSettlesPendingOpenOnceAndAllowsSameIdToReopen() throws Exception {
        HeldCertificate cert = TestCerts.leaf("hub");
        try (MockWebServer server = TestCerts.tlsServer(cert);
             GatedResponse gate = new GatedResponse(1, sse(": connected\n\ndata: accepted\n\n"));
             HubHttpClient client = new HubHttpClient()) {
            server.setDispatcher(gate);
            server.start(TestCerts.loopback(), 0);
            Rec old = new Rec();
            client.openEvents("same", server.url("/events/old").toString(), TestCerts.pin(cert), "secret", old, old);
            gate.awaitRequests();

            client.closeEvents("same");
            client.closeEvents("same");
            assertEquals("failure:NETWORK", old.next());
            Rec replacement = new Rec();
            client.openEvents("same", server.url("/events/new").toString(), TestCerts.pin(cert), "secret", replacement, replacement);
            gate.close();

            assertEquals("open", replacement.next());
            assertEquals("event:message:accepted", replacement.next());
            assertEquals("closed:NETWORK", replacement.next());
            assertNull(old.none());
        }
    }

    @Test
    public void closeBeforeEventHandshakeSuppressesAllCallbacksAndFutureWork() throws Exception {
        HeldCertificate cert = TestCerts.leaf("hub");
        try (MockWebServer server = TestCerts.tlsServer(cert);
             GatedResponse gate = new GatedResponse(1, sse(": connected\n\ndata: late\n\n"));
             HubHttpClient client = new HubHttpClient()) {
            server.setDispatcher(gate);
            server.start(TestCerts.loopback(), 0);
            Rec rec = new Rec();
            client.openEvents("events", server.url("/events").toString(), TestCerts.pin(cert), "secret", rec, rec);
            gate.awaitRequests();

            client.close();
            client.close();
            gate.close();
            client.openEvents("late", server.url("/events/late").toString(), TestCerts.pin(cert), "secret", rec, rec);
            client.request(server.url("/health").toString(), "GET", null, TestCerts.pin(cert), "secret", 5000, rec);
            client.closeEvents("events");

            assertNull(rec.none());
            assertEquals(1, server.getRequestCount());
        }
    }

    @Test
    public void closeDuringRequestSuppressesItsTerminalCallback() throws Exception {
        HeldCertificate cert = TestCerts.leaf("hub");
        try (MockWebServer server = TestCerts.tlsServer(cert);
             GatedResponse gate = new GatedResponse(1, new MockResponse().setBody("late"));
             HubHttpClient client = new HubHttpClient()) {
            server.setDispatcher(gate);
            server.start(TestCerts.loopback(), 0);
            Rec rec = new Rec();
            client.request(server.url("/rpc/ask").toString(), "POST", "{}", TestCerts.pin(cert), "secret", 5000, rec);
            gate.awaitRequests();

            client.close();
            gate.close();

            assertNull(rec.none());
        }
    }

    @Test
    public void closeFromOpenCallbackSuppressesAlreadyBufferedEvents() throws Exception {
        HeldCertificate cert = TestCerts.leaf("hub");
        try (MockWebServer server = TestCerts.tlsServer(cert); HubHttpClient client = new HubHttpClient()) {
            server.enqueue(sse(": connected\n\ndata: must not escape\n\n"));
            server.start(TestCerts.loopback(), 0);
            Rec rec = new Rec();
            client.openEvents("events", server.url("/events").toString(), TestCerts.pin(cert), "secret", rec,
                new HubHttpClient.OpenCallback() {
                    @Override public void onOpen() {
                        rec.onOpen();
                        client.close();
                    }
                    @Override public void onFailure(String code) { rec.onFailure(code); }
                });

            assertEquals("open", rec.next());
            assertNull(rec.none());
        }
    }

    @Test
    public void closingOneOwnerDoesNotCancelAnotherOwnersSameStreamId() throws Exception {
        HeldCertificate cert = TestCerts.leaf("hub");
        try (MockWebServer server = TestCerts.tlsServer(cert);
             GatedResponse gate = new GatedResponse(2, sse(": connected\n\ndata: service survives\n\n"));
             HubHttpClient activity = new HubHttpClient();
             HubHttpClient service = new HubHttpClient()) {
            server.setDispatcher(gate);
            server.start(TestCerts.loopback(), 0);
            String pin = TestCerts.pin(cert);
            Rec activityRec = new Rec();
            Rec serviceRec = new Rec();
            activity.openEvents("same", server.url("/events/activity").toString(), pin, "secret", activityRec, activityRec);
            service.openEvents("same", server.url("/events/service").toString(), pin, "secret", serviceRec, serviceRec);
            gate.awaitRequests();

            activity.close();
            gate.close();

            assertEquals("open", serviceRec.next());
            assertEquals("event:message:service survives", serviceRec.next());
            assertEquals("closed:NETWORK", serviceRec.next());
            assertNull(activityRec.none());
        }
    }
}
