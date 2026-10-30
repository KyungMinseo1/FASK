package io.github.kyungminseo1.fask;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.After;
import org.junit.Test;

public class OverlaySessionTest {
    private static OverlaySession create() {
        OverlaySession session = new OverlaySession(new String[] { "192.168.1.2" }, 443,
            "fingerprint", "secret", null, null, "profile", "project", null);
        OverlaySession.current = session;
        session.awaitConsent();
        return session;
    }

    private static OverlaySession.StartResult record(List<String> results) {
        return new OverlaySession.StartResult() {
            @Override public void active(String id) { results.add("active:" + id); }
            @Override public void failed(String code, String message) { results.add(code); }
        };
    }

    @After public void clear() {
        OverlaySession.current = null;
        OverlaySession.revokedFingerprint = null;
    }

    @Test public void stopDuringConsentRejectsLateConsentAndSettlesOnce() {
        OverlaySession session = create();
        long epoch = session.epoch;
        List<String> results = new ArrayList<>();
        session.addStart(record(results));
        AtomicInteger stops = new AtomicInteger();
        session.stop("CANCELLED", "cancelled", stops::incrementAndGet);
        assertFalse(session.beginStarting(epoch));
        assertFalse(session.activate(epoch));
        session.stop("CANCELLED", "cancelled", stops::incrementAndGet);
        assertEquals(List.of("CANCELLED"), results);
        assertEquals(2, stops.get());
        assertEquals(OverlaySession.State.STOPPED, session.state);
        assertNull(OverlaySession.current);
    }

    @Test public void activeIsNotReportedUntilInitializationCompletes() {
        OverlaySession session = create();
        List<String> first = new ArrayList<>();
        List<String> duplicate = new ArrayList<>();
        session.addStart(record(first));
        assertTrue(session.beginStarting(session.epoch));
        session.addStart(record(duplicate));
        assertEquals(OverlaySession.State.STARTING, session.state);
        assertTrue(first.isEmpty());
        assertTrue(duplicate.isEmpty());
        assertTrue(session.activate(session.epoch));
        assertFalse(session.activate(session.epoch));
        assertEquals(List.of("active:" + session.id), first);
        assertEquals(first, duplicate);
    }

    @Test public void stopDuringInitializationInvalidatesBeforeCleanupAndBlocksNewSession() {
        OverlaySession session = create();
        long epoch = session.epoch;
        assertTrue(session.beginStarting(epoch));
        List<String> result = new ArrayList<>();
        session.addStart(record(result));
        AtomicInteger releases = new AtomicInteger();
        session.stopResources = () -> {
            assertEquals(OverlaySession.State.STOPPING, session.state);
            assertFalse(session.isCurrent(epoch));
            assertFalse(session.activate(epoch));
            releases.incrementAndGet();
        };
        AtomicInteger stops = new AtomicInteger();
        session.stop("CLOSED", "closed", stops::incrementAndGet);
        session.stop("CLOSED", "closed", stops::incrementAndGet);
        assertSame(session, OverlaySession.current);
        assertEquals(1, releases.get());
        assertEquals(0, stops.get());
        assertEquals(List.of("CLOSED"), result);
        session.stopped();
        session.stopped();
        assertEquals(2, stops.get());
        assertNull(OverlaySession.current);
    }

    @Test public void previousSessionCannotActivateAfterReplacement() {
        OverlaySession previous = create();
        long epoch = previous.epoch;
        assertTrue(previous.beginStarting(epoch));
        previous.stop("CLOSED", "closed", null);
        OverlaySession next = create();
        assertFalse(previous.isCurrent(epoch));
        assertFalse(previous.activate(epoch));
        assertEquals(OverlaySession.State.AWAITING_CONSENT, next.state);
        assertSame(next, OverlaySession.current);
    }

    @Test public void relayIdentityIsPartOfTheSessionContext() {
        String[] addresses = { "192.168.1.2", RelayTunnel.ADDRESS };
        String room = "R".repeat(43);
        OverlaySession a = new OverlaySession(addresses, 443, "fingerprint", "secret",
            "wss://relay.example.dev", room, "profile", "project", null);
        OverlaySession same = new OverlaySession(addresses, 443, "fingerprint", "secret",
            "wss://relay.example.dev", room, "profile", "project", null);
        OverlaySession otherRelay = new OverlaySession(addresses, 443, "fingerprint", "secret",
            "wss://other.example.dev", room, "profile", "project", null);
        assertTrue(a.sameContext(same));
        assertFalse(a.sameContext(otherRelay));
    }
}
