package io.github.kyungminseo1.fask;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Base64;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import okhttp3.OkHttpClient;

/** Trusts exactly one leaf certificate, identified by its SHA-256 fingerprint (base64url, no padding). */
public final class PinnedTrustManager implements X509TrustManager {
    public static final String PIN_MISMATCH = "FASK_PIN_MISMATCH";

    private final byte[] expected;

    public PinnedTrustManager(String fingerprint) {
        this.expected = (fingerprint == null ? "" : fingerprint).getBytes(StandardCharsets.US_ASCII);
    }

    public static String fingerprint(X509Certificate cert) throws CertificateException {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
            return Base64.getUrlEncoder().withoutPadding().encodeToString(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new CertificateException(e);
        }
    }

    @Override
    public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
        if (chain == null || chain.length == 0 || expected.length == 0) {
            throw new CertificateException(PIN_MISMATCH);
        }
        byte[] actual = fingerprint(chain[0]).getBytes(StandardCharsets.US_ASCII);
        if (!MessageDigest.isEqual(actual, expected)) {
            throw new CertificateException(PIN_MISMATCH);
        }
    }

    @Override
    public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
        throw new CertificateException("client certificates not accepted");
    }

    @Override
    public X509Certificate[] getAcceptedIssuers() {
        return new X509Certificate[0];
    }

    public static OkHttpClient client(String fingerprint, long readTimeoutMs) {
        PinnedTrustManager tm = new PinnedTrustManager(fingerprint);
        SSLContext ctx;
        try {
            ctx = SSLContext.getInstance("TLS");
            ctx.init(null, new TrustManager[] { tm }, null);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
        return new OkHttpClient.Builder()
            .sslSocketFactory(ctx.getSocketFactory(), tm)
            // Hub is addressed by IP; identity is established by the leaf pin.
            .hostnameVerifier((h, s) -> true)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(readTimeoutMs, TimeUnit.MILLISECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .build();
    }
}
