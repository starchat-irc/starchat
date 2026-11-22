package net.getstarchat.app;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Notification content for one pushed IRC line (same rules as src/push-sw.js).
 */
final class IrcPushMessage {

    private static final Pattern FORMATTING = Pattern.compile("\u0003(\\d{1,2}(,\\d{1,2})?)?|[\u0002\u000F\u0016\u001D\u001E\u001F\u0011]");
    private static final Pattern CTCP = Pattern.compile("^\u0001(\\S+)(?: (.*?))?\u0001?$", Pattern.DOTALL);

    final String title;
    final String body;
    /** Channel or nick to open on tap, null for server notices. */
    final String target;
    /** Nick of the author ("" for server messages). */
    final String sender;
    /** Channel the message was written in, null for DMs and server messages. */
    final String channel;

    private IrcPushMessage(String title, String body, String target, String sender, String channel) {
        this.title = title;
        this.body = body;
        this.target = target;
        this.sender = sender;
        this.channel = channel;
    }

    /** A private message to the user (own notification channel). */
    boolean isDirect() {
        return target != null && channel == null;
    }

    /** One notification per conversation and connection: a newer message replaces the older one. */
    String tag(String profile) {
        return profile + ":" + (target == null ? "server" : target.toLowerCase(Locale.ROOT));
    }

    static IrcPushMessage parse(String line) {
        return parse(line, "");
    }

    /** @param network title of server messages and invites: the name of the connection */
    static IrcPushMessage parse(String line, String network) {
        String rest = line == null ? "" : line.replaceAll("[\r\n]+$", "");
        if (rest.startsWith("@")) {
            int end = rest.indexOf(' ');
            rest = end == -1 ? "" : rest.substring(end + 1).trim();
        }
        String nick = "";
        if (rest.startsWith(":")) {
            int end = rest.indexOf(' ');
            String source = end == -1 ? rest.substring(1) : rest.substring(1, end);
            nick = source.split("!", 2)[0];
            rest = end == -1 ? "" : rest.substring(end + 1).trim();
        }
        int trailingAt = rest.indexOf(" :");
        String head = trailingAt == -1 ? rest : rest.substring(0, trailingAt);
        List<String> params = new ArrayList<>();
        for (String part : head.split(" ")) {
            if (!part.isEmpty()) {
                params.add(part);
            }
        }
        String command = params.isEmpty() ? "" : params.remove(0).toUpperCase(Locale.ROOT);
        if (trailingAt != -1) {
            params.add(rest.substring(trailingAt + 2));
        }

        IrcPushMessage fallback = new IrcPushMessage(network, "", null, nick, null);
        if (!command.equals("PRIVMSG") && !command.equals("NOTICE")) {
            if (command.equals("INVITE") && params.size() > 1) {
                return new IrcPushMessage(network, nick + " → " + params.get(1), null, nick, null);
            }
            return fallback;
        }

        String recipient = params.isEmpty() ? "" : params.get(0);
        boolean isChannel = recipient.startsWith("#") || recipient.startsWith("&");
        String text = params.size() > 1 ? params.get(1) : "";
        boolean isAction = false;
        Matcher ctcp = CTCP.matcher(text);
        if (ctcp.matches()) {
            if (!ctcp.group(1).equalsIgnoreCase("ACTION")) {
                return fallback;
            }
            isAction = true;
            text = ctcp.group(2) == null ? "" : ctcp.group(2);
        }
        text = FORMATTING.matcher(text).replaceAll("").trim();

        return new IrcPushMessage(
            isChannel ? nick + " in " + recipient : nick,
            isAction ? "* " + nick + " " + text : text,
            isChannel ? recipient : nick,
            nick,
            isChannel ? recipient : null);
    }
}
