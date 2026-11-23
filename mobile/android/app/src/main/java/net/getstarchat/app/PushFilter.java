package net.getstarchat.app;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.Collection;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Muted channels and ignored users of one connection. The server cannot read the encrypted
 * pushes, so this device drops them before they become a notification.
 *
 * Also whether call rings are shown at all. Call pushes carry no connection, and the switch
 * is a device setting of the chat, so it is kept once for the device.
 */
final class PushFilter {

    private static final String PREFS = "starchat_push_filter";
    private static final String PREF_MUTED = "muted";
    private static final String PREF_IGNORED = "ignored";
    private static final String PREF_CALLS = "calls";
    private static final int LIMIT = 500;

    final Set<String> muted;
    final Set<String> ignored;

    PushFilter(Collection<String> muted, Collection<String> ignored) {
        this.muted = lowerCase(muted);
        this.ignored = lowerCase(ignored);
    }

    boolean suppresses(IrcPushMessage push) {
        if (push.sender != null && !push.sender.isEmpty() && ignored.contains(push.sender.toLowerCase(Locale.ROOT))) {
            return true;
        }
        return push.channel != null && muted.contains(push.channel.toLowerCase(Locale.ROOT));
    }

    static PushFilter load(Context context, String profile) {
        SharedPreferences prefs = prefs(context);
        return new PushFilter(
            prefs.getStringSet(PREF_MUTED + ":" + profile, new HashSet<>()),
            prefs.getStringSet(PREF_IGNORED + ":" + profile, new HashSet<>()));
    }

    void save(Context context, String profile) {
        prefs(context).edit()
            .putStringSet(PREF_MUTED + ":" + profile, muted)
            .putStringSet(PREF_IGNORED + ":" + profile, ignored)
            .apply();
    }

    static boolean acceptsCalls(Context context) {
        return prefs(context).getBoolean(PREF_CALLS, true);
    }

    static void setAcceptsCalls(Context context, boolean accepts) {
        prefs(context).edit().putBoolean(PREF_CALLS, accepts).apply();
    }

    static void clear(Context context, String profile) {
        prefs(context).edit().remove(PREF_MUTED + ":" + profile).remove(PREF_IGNORED + ":" + profile).apply();
    }

    private static Set<String> lowerCase(Collection<String> values) {
        Set<String> result = new HashSet<>();
        if (values == null) {
            return result;
        }
        for (String value : values) {
            if (value != null && !value.trim().isEmpty() && result.size() < LIMIT) {
                result.add(value.trim().toLowerCase(Locale.ROOT));
            }
        }
        return result;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
