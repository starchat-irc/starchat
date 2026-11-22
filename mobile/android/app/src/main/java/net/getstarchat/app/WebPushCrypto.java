package net.getstarchat.app;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Receiving side of Web Push message encryption (RFC 8291, content coding aes128gcm from RFC 8188).
 * Plain Java on byte arrays so it runs in JVM unit tests.
 */
final class WebPushCrypto {

    static final int PUBLIC_KEY_BYTES = 65;
    static final int AUTH_SECRET_BYTES = 16;

    private static final int SALT_BYTES = 16;
    private static final int HEADER_BYTES = SALT_BYTES + 4 + 1;
    private static final int TAG_BYTES = 16;
    private static final byte LAST_RECORD_DELIMITER = 2;

    private WebPushCrypto() {
    }

    static KeyPair generateKeyPair() throws GeneralSecurityException {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        return generator.generateKeyPair();
    }

    /** Uncompressed point (0x04 || X || Y), the format of the p256dh key. */
    static byte[] encodePublicKey(ECPublicKey key) {
        byte[] encoded = new byte[PUBLIC_KEY_BYTES];
        encoded[0] = 0x04;
        copyUnsigned(key.getW().getAffineX(), encoded, 1);
        copyUnsigned(key.getW().getAffineY(), encoded, 33);
        return encoded;
    }

    static ECPublicKey decodePublicKey(byte[] raw, ECParameterSpec params) throws GeneralSecurityException {
        if (raw.length != PUBLIC_KEY_BYTES || raw[0] != 0x04) {
            throw new GeneralSecurityException("not an uncompressed P-256 point");
        }
        ECPoint point = new ECPoint(
            new BigInteger(1, Arrays.copyOfRange(raw, 1, 33)),
            new BigInteger(1, Arrays.copyOfRange(raw, 33, 65)));
        return (ECPublicKey) KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(point, params));
    }

    /**
     * @param body       the encrypted push message as posted by the push sender
     * @param uaPrivate  this device's private key
     * @param uaPublic   this device's public key, uncompressed (as registered)
     * @param authSecret the 16-byte auth secret (as registered)
     */
    static byte[] decrypt(byte[] body, ECPrivateKey uaPrivate, byte[] uaPublic, byte[] authSecret) throws GeneralSecurityException {
        if (body.length < HEADER_BYTES) {
            throw new GeneralSecurityException("push message too short");
        }
        byte[] salt = Arrays.copyOfRange(body, 0, SALT_BYTES);
        int recordSize = ByteBuffer.wrap(body, SALT_BYTES, 4).getInt();
        int keyIdLength = body[SALT_BYTES + 4] & 0xff;
        int cipherStart = HEADER_BYTES + keyIdLength;
        if (keyIdLength != PUBLIC_KEY_BYTES || body.length < cipherStart + TAG_BYTES) {
            throw new GeneralSecurityException("malformed aes128gcm header");
        }
        if (body.length - cipherStart > recordSize) {
            throw new GeneralSecurityException("multi-record push messages are not supported");
        }
        byte[] asPublic = Arrays.copyOfRange(body, HEADER_BYTES, cipherStart);

        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(uaPrivate);
        agreement.doPhase(decodePublicKey(asPublic, uaPrivate.getParams()), true);
        byte[] ecdhSecret = agreement.generateSecret();

        byte[] prkKey = hmac(authSecret, ecdhSecret);
        byte[] ikm = hmac(prkKey, concat(ascii("WebPush: info\0"), uaPublic, asPublic, new byte[] {1}));
        byte[] prk = hmac(salt, ikm);
        byte[] contentKey = Arrays.copyOf(hmac(prk, concat(ascii("Content-Encoding: aes128gcm\0"), new byte[] {1})), 16);
        byte[] nonce = Arrays.copyOf(hmac(prk, concat(ascii("Content-Encoding: nonce\0"), new byte[] {1})), 12);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(contentKey, "AES"), new GCMParameterSpec(TAG_BYTES * 8, nonce));
        byte[] padded = cipher.doFinal(body, cipherStart, body.length - cipherStart);

        int end = padded.length - 1;
        while (end >= 0 && padded[end] == 0) {
            end--;
        }
        if (end < 0 || padded[end] != LAST_RECORD_DELIMITER) {
            throw new GeneralSecurityException("invalid record padding");
        }
        return Arrays.copyOf(padded, end);
    }

    private static byte[] hmac(byte[] key, byte[] data) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(data);
    }

    private static byte[] ascii(String value) {
        return value.getBytes(StandardCharsets.US_ASCII);
    }

    private static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] part : parts) {
            out.write(part, 0, part.length);
        }
        return out.toByteArray();
    }

    /** Writes a coordinate as exactly 32 big-endian bytes. */
    private static void copyUnsigned(BigInteger value, byte[] target, int offset) {
        byte[] bytes = value.toByteArray();
        int length = Math.min(bytes.length, 32);
        System.arraycopy(bytes, bytes.length - length, target, offset + 32 - length, length);
    }
}
