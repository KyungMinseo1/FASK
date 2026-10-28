package io.github.kyungminseo1.fask;

import java.net.InetAddress;
import java.security.MessageDigest;
import java.util.Base64;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.tls.HandshakeCertificates;
import okhttp3.tls.HeldCertificate;

final class TestCerts {
    private TestCerts() {}

    static HeldCertificate leaf(String cn) {
        return new HeldCertificate.Builder().commonName(cn).ecdsa256().addSubjectAlternativeName("localhost").build();
    }

    static String pin(HeldCertificate c) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(c.certificate().getEncoded());
        return Base64.getUrlEncoder().withoutPadding().encodeToString(d);
    }

    static MockWebServer tlsServer(HeldCertificate cert, HeldCertificate... intermediates) {
        MockWebServer s = new MockWebServer();
        s.useHttps(new HandshakeCertificates.Builder().heldCertificate(cert, intermediatesOf(intermediates)).build().sslSocketFactory(), false);
        return s;
    }

    private static java.security.cert.X509Certificate[] intermediatesOf(HeldCertificate[] hs) {
        java.security.cert.X509Certificate[] out = new java.security.cert.X509Certificate[hs.length];
        for (int i = 0; i < hs.length; i++) out[i] = hs[i].certificate();
        return out;
    }

    static InetAddress loopback() throws Exception {
        return InetAddress.getByName("127.0.0.1");
    }
}
