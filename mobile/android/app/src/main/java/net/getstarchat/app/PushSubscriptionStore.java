package net.getstarchat.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.SecureRandom;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The Web Push key pair and auth secret of each connection profile. They stay the same
 * across connects (the IRC server keeps the registration); private key and secret are
 * encrypted with the Keystore key. A push belongs to the profile whose keys decrypt it.
 */
final class PushSubscriptionStore {

    private static final String PREFS = "starchat_push_keys";
    private static final String PREF_PRIVATE = "private_key";
    private static final String PREF_PUBLIC = "public_key";
    private static final String PREF_AUTH = "auth_secret";
    private static final String PREF_NAME = "name";
    private static final Pattern PROFILE = Pattern.compile("[A-Za-z0-9-]{1,80}");

    static final class Keys {
        final ECPrivateKey privateKey;
        final byte[] publicKey;
        final byte[] authSecret;

        Keys(ECPrivateKey privateKey, byte[] publicKey, byte[] authSecret) {
            this.privateKey = privateKey;
            this.publicKey = publicKey;
            this.authSecret = authSecret;
        }
    }

    private PushSubscriptionStore() {
    }

    static boolean isValidProfile(String profile) {
        return profile != null && PROFILE.matcher(profile).matches();
    }

    /** Null when the profile has no keys yet or they can no longer be read (Keystore key gone). */
    static Keys load(Context context, String profile) {
        SharedPreferences prefs = prefs(context);
        String privateKey = prefs.getString(key(PREF_PRIVATE, profile), null);
        String publicKey = prefs.getString(key(PREF_PUBLIC, profile), null);
        String auth = prefs.getString(key(PREF_AUTH, profile), null);
        if (privateKey == null || publicKey == null || auth == null) {
            return null;
        }
        try {
            byte[] pkcs8 = Base64.decode(SecureStore.decrypt(privateKey), Base64.NO_WRAP);
            ECPrivateKey key = (ECPrivateKey) KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(pkcs8));
            return new Keys(key, Base64.decode(publicKey, Base64.NO_WRAP), Base64.decode(SecureStore.decrypt(auth), Base64.NO_WRAP));
        } catch (Exception e) {
            clear(context, profile);
            return null;
        }
    }

    /** Keys of every profile that has some, by profile id. */
    static Map<String, Keys> loadAll(Context context) {
        Map<String, Keys> result = new LinkedHashMap<>();
        String prefix = PREF_PUBLIC + ":";
        for (String name : prefs(context).getAll().keySet()) {
            if (!name.startsWith(prefix)) {
                continue;
            }
            String profile = name.substring(prefix.length());
            Keys keys = load(context, profile);
            if (keys != null) {
                result.put(profile, keys);
            }
        }
        return result;
    }

    static Keys loadOrCreate(Context context, String profile) throws Exception {
        Keys existing = load(context, profile);
        if (existing != null) {
            return existing;
        }
        KeyPair pair = WebPushCrypto.generateKeyPair();
        byte[] publicKey = WebPushCrypto.encodePublicKey((ECPublicKey) pair.getPublic());
        byte[] auth = new byte[WebPushCrypto.AUTH_SECRET_BYTES];
        new SecureRandom().nextBytes(auth);

        prefs(context).edit()
            .putString(key(PREF_PRIVATE, profile), SecureStore.encrypt(Base64.encodeToString(pair.getPrivate().getEncoded(), Base64.NO_WRAP)))
            .putString(key(PREF_PUBLIC, profile), Base64.encodeToString(publicKey, Base64.NO_WRAP))
            .putString(key(PREF_AUTH, profile), SecureStore.encrypt(Base64.encodeToString(auth, Base64.NO_WRAP)))
            .apply();
        return new Keys((ECPrivateKey) pair.getPrivate(), publicKey, auth);
    }

    static void clear(Context context, String profile) {
        prefs(context).edit()
            .remove(key(PREF_PRIVATE, profile))
            .remove(key(PREF_PUBLIC, profile))
            .remove(key(PREF_AUTH, profile))
            .remove(key(PREF_NAME, profile))
            .apply();
    }

    /** Name of the connection, the title of server messages in notifications. */
    static void setName(Context context, String profile, String name) {
        prefs(context).edit().putString(key(PREF_NAME, profile), name == null ? "" : name).apply();
    }

    static String name(Context context, String profile) {
        return prefs(context).getString(key(PREF_NAME, profile), "");
    }

    private static String key(String name, String profile) {
        return name + ":" + profile;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
