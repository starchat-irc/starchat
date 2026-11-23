package net.getstarchat.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import android.util.Base64;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Receives the IRC server's Web Push (relayed by the network through FCM), decrypts it with
 * the keys of the connection it was registered for and shows a notification. While the app
 * is open the connected chat shows the message itself. Muted channels and ignored users ({@link PushFilter}) stay silent;
 * DMs and mentions use separate notification channels, so each can be set loud or quiet.
 *
 * Voice calls come as plain data from the network ("call" = invite or cancel), not as Web Push:
 * an invite shows a ringing notification with answer and decline, which open the chat with
 * the target "call:..." (the chat then answers over IRC); a cancel takes it back.
 */
public class PushMessagingService extends FirebaseMessagingService {

    static final String EXTRA_TARGET = "net.getstarchat.app.PUSH_TARGET";
    /** Connection profile of the push; calls carry none and open the connection on screen. */
    static final String EXTRA_PROFILE = "net.getstarchat.app.PUSH_PROFILE";
    static final String CHANNEL_DIRECT = "direct_messages";
    static final String CHANNEL_MENTIONS = "mentions";
    static final String CHANNEL_CALLS = "calls";
    private static final int MESSAGE_NOTIFICATION_ID = 1;
    private static final int CALL_NOTIFICATION_ID = 2;
    /** The caller stops ringing after 40 seconds. */
    private static final long CALL_TIMEOUT_MS = 45000;
    private static final Pattern CALL_ID = Pattern.compile("[A-Za-z0-9]{1,32}");
    /** Single channel of the first test builds, replaced by the two above. */
    private static final String LEGACY_CHANNEL = "messages";
    private static final String TAG = "StarChatPush";

    @Override
    public void onMessageReceived(RemoteMessage message) {
        if (message.getData().containsKey("call")) {
            handleCall(message.getData());
            return;
        }
        String encoded = message.getData().get("webpush");
        if (encoded == null) {
            return;
        }
        byte[] body;
        try {
            body = Base64.decode(encoded, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            return;
        }
        // The keys that decrypt the push tell which connection it belongs to
        for (Map.Entry<String, PushSubscriptionStore.Keys> entry : PushSubscriptionStore.loadAll(this).entrySet()) {
            PushSubscriptionStore.Keys keys = entry.getValue();
            String line;
            try {
                line = new String(WebPushCrypto.decrypt(body, keys.privateKey, keys.publicKey, keys.authSecret), StandardCharsets.UTF_8);
            } catch (Exception e) {
                continue;
            }
            String profile = entry.getKey();
            IrcPushMessage push = IrcPushMessage.parse(line, PushSubscriptionStore.name(this, profile));
            if (push.isReadMarker()) {
                clearRead(profile, push);
                return;
            }
            if (MainActivity.isInForeground()) {
                return;
            }
            if (!PushFilter.load(this, profile).suppresses(push)) {
                show(profile, push);
            }
            return;
        }
        Log.w(TAG, "push matches no connection");
    }

    private void handleCall(Map<String, String> data) {
        String id = data.get("call_id");
        String nick = data.get("nick");
        String account = data.get("account");
        if (id == null || !CALL_ID.matcher(id).matches() || nick == null || nick.isEmpty() || account == null || account.isEmpty()) {
            return;
        }
        NotificationManagerCompat manager = NotificationManagerCompat.from(this);
        if ("cancel".equals(data.get("call"))) {
            manager.cancel(callTag(id), CALL_NOTIFICATION_ID);
            return;
        }
        // In the foreground the chat rings itself; calls switched off in the chat never ring
        if (!"invite".equals(data.get("call")) || MainActivity.isInForeground() || !manager.areNotificationsEnabled()
                || !PushFilter.acceptsCalls(this)) {
            return;
        }
        ensureChannels(this);

        NotificationCompat.Builder notification = new NotificationCompat.Builder(this, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_stat_message)
            .setContentTitle(getString(R.string.call_incoming_title, nick))
            .setContentText(getString(R.string.call_incoming_text))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setTimeoutAfter(CALL_TIMEOUT_MS)
            .setAutoCancel(true)
            .setContentIntent(callIntent(id, nick, account, null))
            .addAction(0, getString(R.string.call_decline), callIntent(id, nick, account, "decline"))
            .addAction(0, getString(R.string.call_accept), callIntent(id, nick, account, "accept"));
        try {
            manager.notify(callTag(id), CALL_NOTIFICATION_ID, notification.build());
        } catch (SecurityException e) {
            Log.w(TAG, "notification permission missing", e);
        }
    }

    /** Opens the chat with the call target; the chat reads it like the target of a message push. */
    private PendingIntent callIntent(String id, String nick, String account, String answer) {
        String target = "call:id=" + Uri.encode(id) + "&nick=" + Uri.encode(nick) + "&account=" + Uri.encode(account)
            + (answer != null ? "&answer=" + answer : "");
        Intent open = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_TARGET, target);
        return PendingIntent.getActivity(this, target.hashCode(), open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static String callTag(String id) {
        return "call-" + id;
    }

    @Override
    public void onNewToken(String token) {
        // The chat registers the new token on its next connect; the old endpoint then answers 410.
    }

    /**
     * Read in another session (MARKREAD push of Ergo): the notification of the conversation
     * goes, unless it already shows a newer message.
     */
    private void clearRead(String profile, IrcPushMessage push) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }
        String tag = push.tag(profile);
        for (StatusBarNotification active : manager.getActiveNotifications()) {
            if (active.getId() == MESSAGE_NOTIFICATION_ID && tag.equals(active.getTag())
                    && active.getNotification().when <= push.time) {
                manager.cancel(tag, MESSAGE_NOTIFICATION_ID);
            }
        }
    }

    private void show(String profile, IrcPushMessage push) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(this);
        if (!manager.areNotificationsEnabled()) {
            return;
        }
        ensureChannels(this);

        Intent open = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_PROFILE, profile)
            .putExtra(EXTRA_TARGET, push.target);
        PendingIntent tap = PendingIntent.getActivity(this, push.tag(profile).hashCode(), open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder notification = new NotificationCompat.Builder(this, push.isDirect() ? CHANNEL_DIRECT : CHANNEL_MENTIONS)
            .setSmallIcon(R.drawable.ic_stat_message)
            .setContentTitle(push.title)
            .setContentText(push.body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(push.body))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(tap);
        if (push.time > 0) {
            // Message time, compared with the MARKREAD of other sessions in clearRead()
            notification.setWhen(push.time).setShowWhen(true);
        }
        try {
            manager.notify(push.tag(profile), MESSAGE_NOTIFICATION_ID, notification.build());
        } catch (SecurityException e) {
            Log.w(TAG, "notification permission missing", e);
        }
    }

    /** Also called at app start, so both channels show up in the Android settings before the first push. */
    static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.deleteNotificationChannel(LEGACY_CHANNEL);
        manager.createNotificationChannel(channel(context, CHANNEL_DIRECT, R.string.push_channel_direct, R.string.push_channel_direct_description));
        manager.createNotificationChannel(channel(context, CHANNEL_MENTIONS, R.string.push_channel_mentions, R.string.push_channel_mentions_description));
        NotificationChannel calls = channel(context, CHANNEL_CALLS, R.string.push_channel_calls, R.string.push_channel_calls_description);
        calls.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build());
        manager.createNotificationChannel(calls);
    }

    private static NotificationChannel channel(Context context, String id, int name, int description) {
        NotificationChannel channel = new NotificationChannel(id, context.getString(name), NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription(context.getString(description));
        return channel;
    }
}
