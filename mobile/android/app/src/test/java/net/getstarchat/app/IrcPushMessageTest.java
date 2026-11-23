package net.getstarchat.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

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
    public void messagesCarryTheirServerTime() {
        IrcPushMessage push = IrcPushMessage.parse("@msgid=abc;time=2026-11-23T10:00:00.250Z :Spock!s@h PRIVMSG klaas :hi");
        assertEquals(1795428000250L, push.time);
        assertFalse(push.isReadMarker());
        assertEquals(1795428000000L, IrcPushMessage.parseTime("2026-11-23T10:00:00Z"));
        assertEquals(0, IrcPushMessage.parse(":Spock!s@h PRIVMSG klaas :hi").time);
        assertEquals(0, IrcPushMessage.parseTime("yesterday"));
    }

    @Test
    public void readMarkerOfAnotherSessionTakesBackTheConversation() {
        IrcPushMessage dm = IrcPushMessage.parse("@time=2026-11-23T10:00:05.000Z :ergo.test MARKREAD Spock timestamp=2026-11-23T10:00:00.250Z");
        assertTrue(dm.isReadMarker());
        assertEquals(1795428000250L, dm.time);
        assertEquals("same tag as the notification of the DM", "p1:spock", dm.tag("p1"));

        IrcPushMessage channel = IrcPushMessage.parse(":ergo.test MARKREAD #Bridge timestamp=2026-11-23T10:00:00.250Z");
        assertEquals("p1:#bridge", channel.tag("p1"));

        assertFalse("a query without timestamp is no marker", IrcPushMessage.parse(":ergo.test MARKREAD #Bridge *").isReadMarker());
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
