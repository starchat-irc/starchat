package net.getstarchat.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

public class NativeSocketsTest {

    private ServerSocket server;
    private final BlockingQueue<String> events = new LinkedBlockingQueue<>();
    private NativeSockets sockets;

    @Before
    public void setUp() throws Exception {
        server = new ServerSocket(0);
        sockets = new NativeSockets((id, event, data) -> events.add(id + " " + event + (data != null ? " " + data : "")));
    }

    @After
    public void tearDown() throws Exception {
        sockets.closeAll();
        server.close();
    }

    private String nextEvent() throws InterruptedException {
        String event = events.poll(5, TimeUnit.SECONDS);
        assertNotNull("no socket event within 5 seconds", event);
        return event;
    }

    @Test
    public void linesGoBothWaysAndTheServerCanClose() throws Exception {
        assertNull(sockets.connect("c1", "127.0.0.1", server.getLocalPort(), false));
        try (Socket client = server.accept()) {
            assertEquals("c1 open", nextEvent());

            sockets.send("c1", "NICK kenobi\r\nQUIT");
            BufferedReader in = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
            assertEquals("line breaks inside a line never reach the server as a second command", "NICK kenobi QUIT", in.readLine());

            OutputStream out = client.getOutputStream();
            out.write(":irc.test 001 kenobi :Hellö\r\n\r\nPING :x\n".getBytes(StandardCharsets.UTF_8));
            out.flush();
            assertEquals("c1 message :irc.test 001 kenobi :Hellö", nextEvent());
            assertEquals("c1 message PING :x", nextEvent());
        }
        assertEquals("c1 close", nextEvent());
    }

    @Test
    public void closingSendsQueuedLinesFirstAndReportsNoError() throws Exception {
        assertNull(sockets.connect("c2", "127.0.0.1", server.getLocalPort(), false));
        try (Socket client = server.accept()) {
            assertEquals("c2 open", nextEvent());
            sockets.send("c2", "QUIT :bye");
            sockets.close("c2");
            BufferedReader in = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
            assertEquals("QUIT :bye", in.readLine());
            assertNull(in.readLine());
        }
        assertEquals("c2 close", nextEvent());
    }

    @Test
    public void refusedConnectionsReportAnErrorAndClose() throws Exception {
        int port = server.getLocalPort();
        server.close();
        assertNull(sockets.connect("c3", "127.0.0.1", port, false));
        assertEquals("c3 error refused", nextEvent());
        assertEquals("c3 close", nextEvent());
        assertEquals("refused", NativeSockets.test("127.0.0.1", port, false));
    }

    @Test
    public void invalidRequestsAreRefused() {
        assertEquals("invalid server", sockets.connect("c4", "irc.example.org/path", 6697, true));
        assertEquals("invalid server", sockets.connect("c4", "irc.example.org", 70000, true));
        assertEquals("invalid id", sockets.connect("../x", "irc.example.org", 6697, true));
        assertTrue(NativeSockets.isValidTarget("[2001:db8::1]", 6697));
        assertFalse(NativeSockets.isValidTarget("", 6697));
        assertEquals("invalid", NativeSockets.test("ircs://irc.example.org", 6697, true));
    }

    @Test
    public void reachableServersPassTheTest() {
        assertNull(NativeSockets.test("127.0.0.1", server.getLocalPort(), false));
    }
}
