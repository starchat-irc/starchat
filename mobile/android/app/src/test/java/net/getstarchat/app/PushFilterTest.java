package net.getstarchat.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;

public class PushFilterTest {

    private final PushFilter filter = new PushFilter(Arrays.asList("#Bridge", " "), Collections.singletonList("Q"));

    @Test
    public void mutedChannelsAndIgnoredUsersAreSilent() {
        assertTrue(filter.suppresses(IrcPushMessage.parse(":Spock!s@h PRIVMSG #bridge :klaas: hi")));
        assertTrue(filter.suppresses(IrcPushMessage.parse(":q!q@h PRIVMSG klaas :boo")));
        assertTrue("ignored users are silent in channels too", filter.suppresses(IrcPushMessage.parse(":Q!q@h PRIVMSG #Engineering :klaas!")));
    }

    @Test
    public void everythingElseIsShown() {
        assertFalse(filter.suppresses(IrcPushMessage.parse(":Spock!s@h PRIVMSG #Engineering :klaas: hi")));
        assertFalse(filter.suppresses(IrcPushMessage.parse(":Spock!s@h PRIVMSG klaas :hi")));
        assertFalse(new PushFilter(null, null).suppresses(IrcPushMessage.parse(":Spock!s@h PRIVMSG #bridge :klaas")));
        assertEquals(1, filter.muted.size());
    }

    @Test
    public void pushesKnowTheirSenderAndKind() {
        IrcPushMessage mention = IrcPushMessage.parse(":Spock!s@h PRIVMSG #Bridge :klaas: hi");
        assertEquals("Spock", mention.sender);
        assertEquals("#Bridge", mention.channel);
        assertFalse(mention.isDirect());

        IrcPushMessage dm = IrcPushMessage.parse(":Spock!s@h PRIVMSG klaas :hi");
        assertNull(dm.channel);
        assertTrue(dm.isDirect());

        assertFalse("invites go to the mentions channel", IrcPushMessage.parse(":Spock!s@h INVITE klaas #Bridge").isDirect());
    }
}
