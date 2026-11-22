package net.getstarchat.app;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.cert.CertPathValidatorException;
import java.security.cert.CertificateException;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.regex.Pattern;

import javax.net.ssl.SSLException;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * IRC over TCP for the chat (counterpart of the native sockets in desktop/main.js). The chat
 * sends lines through the shell, this class owns the sockets and reports open, message,
 * error and close. TLS checks the certificate and the host name like a browser does.
 */
final class NativeSockets {

    /** Receives socket events; called on the socket threads. */
    interface Listener {
        void onEvent(String id, String event, String data);
    }

    static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int MAX_CONNECTIONS = 16;
    private static final int MAX_LINE_BYTES = 8192;
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9-]{1,80}");
    private static final Pattern HOST = Pattern.compile("^(?:\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$");

    private final Listener listener;
    private final Map<String, Connection> connections = new ConcurrentHashMap<>();

    NativeSockets(Listener listener) {
        this.listener = listener;
    }

    static boolean isValidTarget(String host, int port) {
        return host != null && HOST.matcher(host).matches() && port >= 1 && port <= 65535;
    }

    /** Opens a socket in the background; the result arrives as "open" or "error" plus "close". */
    String connect(String id, String host, int port, boolean tls) {
        if (id == null || !ID.matcher(id).matches()) {
            return "invalid id";
        }
        if (!isValidTarget(host, port)) {
            return "invalid server";
        }
        if (connections.size() >= MAX_CONNECTIONS || connections.containsKey(id)) {
            return "too many connections";
        }
        Connection connection = new Connection(id, host, port, tls);
        connections.put(id, connection);
        connection.start();
        return null;
    }

    void send(String id, String line) {
        Connection connection = connections.get(id);
        if (connection != null && line != null) {
            connection.send(line);
        }
    }

    void close(String id) {
        Connection connection = connections.remove(id);
        if (connection != null) {
            connection.close();
        }
    }

    void closeAll() {
        for (String id : connections.keySet()) {
            close(id);
        }
    }

    /** Connects and closes again without sending anything: the test on the connections page. */
    static String test(String host, int port, boolean tls) {
        if (!isValidTarget(host, port)) {
            return "invalid";
        }
        try (Socket socket = open(host, port, tls)) {
            return null;
        } catch (IOException e) {
            return reason(e);
        }
    }

    /** Short reason for the chat, matching the codes of the desktop app. */
    static String reason(IOException e) {
        if (e instanceof UnknownHostException) {
            return "not-found";
        }
        if (e instanceof SocketTimeoutException) {
            return "timeout";
        }
        if (e instanceof SSLHandshakeException) {
            for (Throwable cause = e.getCause(); cause != null; cause = cause.getCause()) {
                if (cause instanceof CertificateException || cause instanceof CertPathValidatorException) {
                    return "certificate";
                }
            }
            String message = String.valueOf(e.getMessage()).toLowerCase(Locale.ROOT);
            return message.contains("certificate") || message.contains("hostname") ? "certificate" : "tls";
        }
        if (e instanceof SSLException) {
            return "tls";
        }
        if (e instanceof ConnectException) {
            return "refused";
        }
        return "unknown";
    }

    private static Socket open(String host, int port, boolean tls) throws IOException {
        String bareHost = host.startsWith("[") ? host.substring(1, host.length() - 1) : host;
        Socket plain = new Socket();
        plain.setKeepAlive(true);
        plain.connect(new InetSocketAddress(bareHost, port), CONNECT_TIMEOUT_MS);
        if (!tls) {
            return plain;
        }
        SSLSocket socket = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(plain, bareHost, port, true);
        // SSLSocket checks the chain only; the host name check is switched on here
        SSLParameters parameters = socket.getSSLParameters();
        parameters.setEndpointIdentificationAlgorithm("HTTPS");
        socket.setSSLParameters(parameters);
        socket.setSoTimeout(CONNECT_TIMEOUT_MS);
        socket.startHandshake();
        socket.setSoTimeout(0);
        return socket;
    }

    private final class Connection {
        private final String id;
        private final String host;
        private final int port;
        private final boolean tls;
        private final ExecutorService writer = Executors.newSingleThreadExecutor();
        private volatile Socket socket;
        private volatile boolean closed;

        Connection(String id, String host, int port, boolean tls) {
            this.id = id;
            this.host = host;
            this.port = port;
            this.tls = tls;
        }

        void start() {
            Thread reader = new Thread(this::run, "irc-" + id);
            reader.setDaemon(true);
            reader.start();
        }

        private void run() {
            try {
                socket = open(host, port, tls);
                if (closed) {
                    socket.close();
                    return;
                }
                listener.onEvent(id, "open", null);
                BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8), MAX_LINE_BYTES);
                String line;
                while (!closed && (line = in.readLine()) != null) {
                    if (!line.isEmpty()) {
                        listener.onEvent(id, "message", line);
                    }
                }
            } catch (IOException e) {
                if (!closed) {
                    listener.onEvent(id, "error", reason(e));
                }
            } finally {
                connections.remove(id, this);
                closed = true;
                shutdown();
                writer.shutdown();
                listener.onEvent(id, "close", null);
            }
        }

        void send(String line) {
            String clean = line.replaceAll("[\r\n]+", " ");
            try {
                writer.execute(() -> write(clean));
            } catch (RejectedExecutionException ignored) {
                // closing: nothing more goes out
            }
        }

        private void write(String line) {
            Socket current = socket;
            if (current == null || closed) {
                return;
            }
            try {
                OutputStream out = current.getOutputStream();
                out.write((line + "\r\n").getBytes(StandardCharsets.UTF_8));
                out.flush();
            } catch (IOException e) {
                shutdown();
            }
        }

        void close() {
            if (closed) {
                return;
            }
            // After the lines already queued, so a QUIT still goes out
            try {
                writer.execute(() -> {
                    closed = true;
                    shutdown();
                });
                writer.shutdown();
            } catch (RejectedExecutionException e) {
                closed = true;
                shutdown();
            }
        }

        private void shutdown() {
            Socket current = socket;
            if (current != null) {
                try {
                    current.close();
                } catch (IOException ignored) {
                    // already closed
                }
            }
        }
    }
}
