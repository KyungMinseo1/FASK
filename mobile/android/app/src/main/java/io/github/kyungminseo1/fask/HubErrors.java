package io.github.kyungminseo1.fask;

import java.util.ArrayDeque;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;

public final class HubErrors {
    private HubErrors() {}

    public static String classify(Throwable t) {
        Set<Throwable> seen = Collections.newSetFromMap(new IdentityHashMap<>());
        ArrayDeque<Throwable> queue = new ArrayDeque<>();
        if (t != null) queue.add(t);
        while (!queue.isEmpty()) {
            Throwable cur = queue.poll();
            if (!seen.add(cur)) continue;
            String msg = cur.getMessage();
            if (msg != null && msg.contains(PinnedTrustManager.PIN_MISMATCH)) return "PIN_MISMATCH";
            if (cur.getCause() != null) queue.add(cur.getCause());
            Collections.addAll(queue, cur.getSuppressed());
        }
        return "NETWORK";
    }
}
