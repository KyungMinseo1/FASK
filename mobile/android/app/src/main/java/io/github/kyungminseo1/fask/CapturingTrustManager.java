package io.github.kyungminseo1.fask;

import java.security.GeneralSecurityException;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import okhttp3.OkHttpClient;

/**
 * Code pairing only: accepts any leaf and records its SHA-256 fingerprint (base64url, no padding).
 * Safety comes from the OPAQUE exchange, which binds the recorded fingerprint into its context;
 * no bearer token is ever sent through a client built here.
 */
public final class CapturingTrustManager implements X509TrustManager {
    private volatile String fingerprint;

    /** The leaf fingerprint seen by the last handshake, or null before any handshake. */
    public String fingerprint() {
        return fingerprint;
    }

    @Override
    public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
        if (chain == null || chain.length == 0) throw new CertificateException("empty chain");
        fingerprint = PinnedTrustManager.fingerprint(chain[0]);
    }

    @Override
    public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
        throw new CertificateException("client certificates not accepted");
    }

    @Override
    public X509Certificate[] getAcceptedIssuers() {
        return new X509Certificate[0];
    }

    /** A fresh SSLContext per client, so no session resumption can skip the capture. */
    public static OkHttpClient client(CapturingTrustManager tm, long timeoutMs) {
        SSLContext ctx;
        try {
            ctx = SSLContext.getInstance("TLS");
            ctx.init(null, new TrustManager[] { tm }, null);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
        return new OkHttpClient.Builder()
            .sslSocketFactory(ctx.getSocketFactory(), tm)
            .hostnameVerifier((h, s) -> true)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .build();
    }
}
