package net.getstarchat.app;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;

import androidx.core.content.IntentCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.messaging.FirebaseMessaging;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * Native side of the shell (www/shell): what desktop/main.js does for the desktop app.
 *  - Store: the shell's state (connection profiles, server directory) as JSON strings.
 *    Passwords and tokens inside are encrypted with encrypt/decrypt, whose AES key never
 *    leaves the Android Keystore.
 *  - Sockets: IRC over TCP and TLS for servers without WebSocket ({@link NativeSockets}).
 *  - Push: FCM token plus Web Push keys per connection, tapped notifications.
 *  - Share: text and single files shared from other apps wait here until the chat takes them.
 */
@CapacitorPlugin(
    name = "StarChatShell",
    permissions = {
        @Permission(alias = ShellPlugin.NOTIFICATIONS, strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class ShellPlugin extends Plugin {

    static final String NOTIFICATIONS = "notifications";

    private static final String PREFS = "starchat_shell";
    private static final Pattern STORE_KEY = Pattern.compile("[a-z][a-zA-Z0-9.-]{0,40}");
    private static final int BASE64_URL = Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING;
    /** Upload limit of the chat for shared files. */
    static final long MAX_SHARE_BYTES = 15L * 1024 * 1024;

    /** Notification that started the app, until the shell is ready for it. */
    private JSObject pendingTarget;
    /** Share intent (ACTION_SEND) until the chat takes it. */
    private Intent pendingShare;
    private NativeSockets sockets;
    private final ExecutorService background = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        Intent intent = getActivity().getIntent();
        pendingTarget = takeTarget(intent);
        pendingShare = takeShare(intent);
        PushMessagingService.ensureChannels(getContext());
        sockets = new NativeSockets((id, event, data) -> {
            JSObject payload = new JSObject();
            payload.put("connectionId", id);
            payload.put("event", event);
            if ("error".equals(event)) {
                payload.put("error", data);
            } else if (data != null) {
                payload.put("data", data);
            }
            notifyListeners("socket", payload);
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (sockets != null) {
            sockets.closeAll();
        }
        background.shutdownNow();
        super.handleOnDestroy();
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        JSObject target = takeTarget(intent);
        if (target != null) {
            notifyListeners("pushOpened", target, true);
        }
        Intent share = takeShare(intent);
        if (share != null) {
            pendingShare = share;
            notifyListeners("shareReceived", new JSObject(), true);
        }
    }

    // Store

    @PluginMethod
    public void getStore(PluginCall call) {
        String key = call.getString("key");
        if (!isStoreKey(key)) {
            call.reject("invalid key");
            return;
        }
        JSObject result = new JSObject();
        result.put("value", prefs().getString(key, null));
        call.resolve(result);
    }

    @PluginMethod
    public void setStore(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (!isStoreKey(key)) {
            call.reject("invalid key");
            return;
        }
        SharedPreferences.Editor editor = prefs().edit();
        if (value == null) {
            editor.remove(key);
        } else {
            editor.putString(key, value);
        }
        editor.apply();
        call.resolve();
    }

    @PluginMethod
    public void encrypt(PluginCall call) {
        String value = call.getString("value");
        if (value == null) {
            call.reject("value missing");
            return;
        }
        try {
            JSObject result = new JSObject();
            result.put("value", SecureStore.encrypt(value));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("encryption failed", e);
        }
    }

    /** Resolves with value null when the stored value can no longer be read (Keystore key gone). */
    @PluginMethod
    public void decrypt(PluginCall call) {
        String value = call.getString("value");
        JSObject result = new JSObject();
        try {
            result.put("value", value == null ? null : SecureStore.decrypt(value));
        } catch (Exception e) {
            result.put("value", null);
        }
        call.resolve(result);
    }

    // Sockets

    @PluginMethod
    public void socketConnect(PluginCall call) {
        String error = sockets.connect(
            call.getString("connectionId"),
            call.getString("host"),
            call.getInt("port", 0),
            call.getBoolean("ssl", true));
        if (error != null) {
            call.reject(error);
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void socketSend(PluginCall call) {
        sockets.send(call.getString("connectionId"), call.getString("line"));
        call.resolve();
    }

    @PluginMethod
    public void socketClose(PluginCall call) {
        sockets.close(call.getString("connectionId"));
        call.resolve();
    }

    /** Connects to a server and closes again: { ok, ms } or { ok: false, reason }. */
    @PluginMethod
    public void testConnection(PluginCall call) {
        String host = call.getString("host");
        int port = call.getInt("port", 0);
        boolean tls = call.getBoolean("ssl", true);
        background.execute(() -> {
            long startedAt = System.currentTimeMillis();
            String reason = NativeSockets.test(host, port, tls);
            JSObject result = new JSObject();
            result.put("ok", reason == null);
            if (reason == null) {
                result.put("ms", System.currentTimeMillis() - startedAt);
            } else {
                result.put("reason", reason);
            }
            call.resolve(result);
        });
    }

    // Links and settings

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        Uri uri = url == null ? null : Uri.parse(url);
        String scheme = uri == null ? null : uri.getScheme();
        if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https") || scheme.equalsIgnoreCase("mailto"))) {
            call.reject("unsupported url");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("no app for url", e);
        }
    }

    /** The app's notification settings (sound, vibration per channel). */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        } else {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getContext().getPackageName(), null));
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("no settings app", e);
        }
    }

    // Push

    /**
     * Asks for the notification permission (Android 13+), then returns the FCM token and the
     * Web Push keys of the connection { profile, name }.
     */
    @PluginMethod
    public void pushSubscribe(PluginCall call) {
        if (!PushSubscriptionStore.isValidProfile(call.getString("profile"))) {
            call.reject("invalid profile");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState(NOTIFICATIONS) != PermissionState.GRANTED) {
            requestPermissionForAlias(NOTIFICATIONS, call, "notificationPermissionCallback");
            return;
        }
        subscribe(call);
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        if (getPermissionState(NOTIFICATIONS) != PermissionState.GRANTED) {
            call.reject("notifications denied");
            return;
        }
        subscribe(call);
    }

    /** Logout or a deleted connection: its keys and filter go. The FCM token stays for the others. */
    @PluginMethod
    public void pushUnsubscribe(PluginCall call) {
        String profile = call.getString("profile");
        if (!PushSubscriptionStore.isValidProfile(profile)) {
            call.reject("invalid profile");
            return;
        }
        PushSubscriptionStore.clear(getContext(), profile);
        PushFilter.clear(getContext(), profile);
        if (PushSubscriptionStore.loadAll(getContext()).isEmpty()) {
            try {
                FirebaseMessaging.getInstance().deleteToken();
            } catch (IllegalStateException ignored) {
                // Firebase not configured: nothing registered
            }
        }
        call.resolve();
    }

    /** Muted channels and ignored users of one connection: their pushes are not shown. Also the device switch for call rings. */
    @PluginMethod
    public void setPushFilter(PluginCall call) {
        String profile = call.getString("profile");
        if (!PushSubscriptionStore.isValidProfile(profile)) {
            call.reject("invalid profile");
            return;
        }
        try {
            new PushFilter(strings(call.getArray("muted")), strings(call.getArray("ignored"))).save(getContext(), profile);
            PushFilter.setAcceptsCalls(getContext(), call.getBoolean("calls", true));
            call.resolve();
        } catch (Exception e) {
            call.reject("invalid push filter", e);
        }
    }

    /** { profile, target } of the notification that started the app, or empty. */
    @PluginMethod
    public void takePendingTarget(PluginCall call) {
        JSObject result = pendingTarget != null ? pendingTarget : new JSObject();
        pendingTarget = null;
        call.resolve(result);
    }

    private void subscribe(PluginCall call) {
        String profile = call.getString("profile");
        FirebaseMessaging messaging;
        try {
            messaging = FirebaseMessaging.getInstance();
        } catch (IllegalStateException e) {
            call.reject("push not configured (google-services.json missing)");
            return;
        }
        messaging.getToken().addOnCompleteListener(task -> {
            if (!task.isSuccessful() || task.getResult() == null) {
                call.reject("FCM token unavailable", task.getException());
                return;
            }
            try {
                PushSubscriptionStore.Keys keys = PushSubscriptionStore.loadOrCreate(getContext(), profile);
                PushSubscriptionStore.setName(getContext(), profile, call.getString("name", ""));
                JSObject result = new JSObject();
                result.put("fcmToken", task.getResult());
                result.put("p256dh", Base64.encodeToString(keys.publicKey, BASE64_URL));
                result.put("auth", Base64.encodeToString(keys.authSecret, BASE64_URL));
                call.resolve(result);
            } catch (Exception e) {
                call.reject("push keys could not be created", e);
            }
        });
    }

    // Share

    /**
     * What another app shared: { text, subject } and/or file { name, mimeType, data (base64) },
     * tooLarge (file name) when the file exceeds the upload limit, unreadable when the sharing
     * app gave no access. Empty when nothing waits.
     */
    @PluginMethod
    public void takePendingShare(PluginCall call) {
        Intent share = pendingShare;
        pendingShare = null;
        JSObject result = new JSObject();
        if (share == null) {
            call.resolve(result);
            return;
        }
        result.put("text", share.getStringExtra(Intent.EXTRA_TEXT));
        result.put("subject", share.getStringExtra(Intent.EXTRA_SUBJECT));
        Uri stream = IntentCompat.getParcelableExtra(share, Intent.EXTRA_STREAM, Uri.class);
        if (isReadableShare(stream)) {
            try {
                readSharedFile(stream, share.getType(), result);
            } catch (IOException | SecurityException e) {
                Log.w("StarChatShare", "shared file could not be read", e);
                result.put("unreadable", true);
            }
        }
        call.resolve(result);
    }

    private void readSharedFile(Uri uri, String intentType, JSObject result) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        String name = "shared";
        long size = -1;
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameColumn != -1 && !cursor.isNull(nameColumn)) {
                    name = cursor.getString(nameColumn);
                }
                if (sizeColumn != -1 && !cursor.isNull(sizeColumn)) {
                    size = cursor.getLong(sizeColumn);
                }
            }
        }
        if (size > MAX_SHARE_BYTES) {
            result.put("tooLarge", name);
            return;
        }
        byte[] data;
        try (InputStream in = resolver.openInputStream(uri)) {
            if (in == null) {
                return;
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                if (out.size() > MAX_SHARE_BYTES) {
                    result.put("tooLarge", name);
                    return;
                }
            }
            data = out.toByteArray();
        }
        String mimeType = resolver.getType(uri);
        JSObject file = new JSObject();
        file.put("name", name);
        file.put("mimeType", mimeType != null ? mimeType : intentType);
        file.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
        result.put("file", file);
    }

    /**
     * Only content:// from other apps. file:// or our own FileProvider could make the app
     * upload its private files (profiles, push keys) on behalf of a malicious sharer.
     */
    private boolean isReadableShare(Uri uri) {
        return uri != null
            && ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())
            && !(getContext().getPackageName() + ".fileprovider").equals(uri.getAuthority());
    }

    /** ACTION_SEND intents; the intent is neutralised so a recreated activity does not share twice. */
    private static Intent takeShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) {
            return null;
        }
        Intent share = new Intent(intent);
        intent.setAction(Intent.ACTION_MAIN);
        return share;
    }

    private static JSObject takeTarget(Intent intent) {
        if (intent == null) {
            return null;
        }
        String target = intent.getStringExtra(PushMessagingService.EXTRA_TARGET);
        String profile = intent.getStringExtra(PushMessagingService.EXTRA_PROFILE);
        intent.removeExtra(PushMessagingService.EXTRA_TARGET);
        intent.removeExtra(PushMessagingService.EXTRA_PROFILE);
        if (target == null) {
            return null;
        }
        JSObject result = new JSObject();
        result.put("target", target);
        result.put("profile", profile);
        return result;
    }

    private static List<String> strings(JSArray array) throws Exception {
        List<String> result = new ArrayList<>();
        if (array == null) {
            return result;
        }
        for (Object value : array.toList()) {
            if (value instanceof String) {
                result.add((String) value);
            }
        }
        return result;
    }

    private static boolean isStoreKey(String key) {
        return key != null && STORE_KEY.matcher(key).matches();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
