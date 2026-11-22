package net.getstarchat.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECPrivateKeySpec;
import java.util.Base64;

import org.junit.Test;

public class WebPushCryptoTest {

    /** Example from RFC 8291, section 5 / appendix A. */
    private static final String AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
    private static final String UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    private static final String UA_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
    private static final String BODY = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

    private static byte[] b64(String value) {
        return Base64.getUrlDecoder().decode(value);
    }

    private static ECPrivateKey rfcPrivateKey() throws Exception {
        ECPublicKey anyKey = (ECPublicKey) WebPushCrypto.generateKeyPair().getPublic();
        return (ECPrivateKey) KeyFactory.getInstance("EC")
            .generatePrivate(new ECPrivateKeySpec(new BigInteger(1, b64(UA_PRIVATE)), anyKey.getParams()));
    }

    @Test
    public void decryptsTheRfcExample() throws Exception {
        byte[] plain = WebPushCrypto.decrypt(b64(BODY), rfcPrivateKey(), b64(UA_PUBLIC), b64(AUTH));

        assertEquals("When I grow up, I want to be a watermelon", new String(plain, StandardCharsets.UTF_8));
    }

    @Test
    public void rejectsATamperedMessageOrWrongSecret() throws Exception {
        byte[] tampered = b64(BODY);
        tampered[tampered.length - 1] ^= 1;
        assertThrows(GeneralSecurityException.class,
            () -> WebPushCrypto.decrypt(tampered, rfcPrivateKey(), b64(UA_PUBLIC), b64(AUTH)));

        byte[] wrongAuth = new byte[16];
        assertThrows(GeneralSecurityException.class,
            () -> WebPushCrypto.decrypt(b64(BODY), rfcPrivateKey(), b64(UA_PUBLIC), wrongAuth));

        assertThrows(GeneralSecurityException.class,
            () -> WebPushCrypto.decrypt(new byte[10], rfcPrivateKey(), b64(UA_PUBLIC), b64(AUTH)));
    }

    @Test
    public void publicKeysRoundTripAsUncompressedPoints() throws Exception {
        KeyPair pair = WebPushCrypto.generateKeyPair();
        ECPublicKey publicKey = (ECPublicKey) pair.getPublic();

        byte[] encoded = WebPushCrypto.encodePublicKey(publicKey);
        assertEquals(65, encoded.length);
        assertEquals(0x04, encoded[0]);

        ECPublicKey decoded = WebPushCrypto.decodePublicKey(encoded, publicKey.getParams());
        assertArrayEquals(encoded, WebPushCrypto.encodePublicKey(decoded));
        assertEquals(publicKey.getW(), decoded.getW());
    }
}
