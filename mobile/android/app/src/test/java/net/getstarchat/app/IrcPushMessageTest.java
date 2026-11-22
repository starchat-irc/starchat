package net.getstarchat.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class IrcPushMessageTest {

    @Test
    public void channelMentionShowsNickChannelAndCleanText() {
        IrcPushMessage push = IrcPushMessage.parse("@msgid=abc;time=2026-11-14T10:00:00Z :Spock!s@h PRIVMSG #Bridge :klaas: \u0002Faszinierend\u0002\r\n");

        assertEquals("Spock in #Bridge", push.title);
        assertEquals("klaas: Faszinierend", push.body);
        assertEquals("#Bridge", push.target);
        assertEquals("p1:#bridge", push.tag("p1"));
    }

    @Test
    public void directMessageOpensTheSender() {
        IrcPushMessage push = IrcPushMessage.parse(":Spock!s@h PRIVMSG klaas :\u000304hallo\u0003 du");

        assertEquals("Spock", push.title);
        assertEquals("hallo du", push.body);
        assertEquals("Spock", push.target);
    }

    @Test
    public void actionsAndUnknownLines() {
        assertEquals("* Spock winkt", IrcPushMessage.parse(":Spock!s@h PRIVMSG klaas :\u0001ACTION winkt\u0001").body);

        IrcPushMessage unknown = IrcPushMessage.parse(":irc.test FOO bar", "Libera");
        assertEquals("Libera", unknown.title);
        assertNull(unknown.target);
        assertEquals("p1:server", unknown.tag("p1"));
    }
}
