package io.github.kyungminseo1.fask;

import java.io.IOException;
import okio.ByteString;

/** Relay data frames: DATA = 0x00 + 1..16384 payload bytes, ACK = 0x01 + uint32 BE credit. */
final class RelayFraming {
    static final int DATA = 0;
    static final int ACK = 1;
    static final int CHUNK = 16384;
    static final int WINDOW = 262144;
    static final int ACK_EVERY = 65536;
    static final int MAX_FRAME = CHUNK + 1;

    private RelayFraming() {}

    static ByteString data(byte[] b, int off, int len) {
        byte[] frame = new byte[len + 1];
        frame[0] = DATA;
        System.arraycopy(b, off, frame, 1, len);
        return ByteString.of(frame);
    }

    static ByteString ack(int n) {
        return ByteString.of(new byte[] { ACK, (byte) (n >>> 24), (byte) (n >>> 16), (byte) (n >>> 8), (byte) n });
    }

    /** A parsed frame: DATA carries a payload, ACK carries credit. */
    static final class Frame {
        final int type;
        final ByteString payload;
        final int credit;

        private Frame(int type, ByteString payload, int credit) {
            this.type = type;
            this.payload = payload;
            this.credit = credit;
        }
    }

    static Frame parse(ByteString bytes) throws IOException {
        int size = bytes.size();
        if (size < 2 || size > MAX_FRAME) throw new IOException("relay protocol");
        int type = bytes.getByte(0) & 0xff;
        if (type == DATA) return new Frame(DATA, bytes.substring(1), 0);
        if (type != ACK || size != 5) throw new IOException("relay protocol");
        int n = ((bytes.getByte(1) & 0xff) << 24) | ((bytes.getByte(2) & 0xff) << 16)
            | ((bytes.getByte(3) & 0xff) << 8) | (bytes.getByte(4) & 0xff);
        if (n < 1 || n > WINDOW) throw new IOException("relay protocol");
        return new Frame(ACK, null, n);
    }

    /** Sender-side credit: DATA bytes sent but not yet acked never exceed WINDOW. */
    static final class Window {
        private int unacked;
        private int max;
        private boolean closed;

        synchronized void acquire(int n) throws IOException, InterruptedException {
            while (!closed && unacked + n > WINDOW) wait();
            if (closed) throw new IOException("relay closed");
            unacked += n;
            max = Math.max(max, unacked);
        }

        synchronized void release(int n) throws IOException {
            if (n > unacked) throw new IOException("relay protocol");
            unacked -= n;
            notifyAll();
        }

        synchronized void close() {
            closed = true;
            notifyAll();
        }

        synchronized int maxUnacked() {
            return max;
        }
    }
}
