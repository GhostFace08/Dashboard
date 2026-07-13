import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.FileTime;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.logging.*;

/**
 * DashboardMiddleware — Unified MCP Dashboard backend.
 *
 * REST endpoints:
 *
 *   GET  /api/issues              → serves backend/data/all_issues.json (raw)
 *   GET  /api/status              → returns file-watch metadata + hasNewData flag
 *   POST /api/refresh             → schedules a deferred file check (~60 s)
 *   GET  /api/config/:filename    → reads  backend/data/<filename> as text
 *   PUT  /api/config/:filename    → writes backend/data/<filename> from request body
 *
 * Change 3 additions:
 *   - In-memory metadata store (lastFileTimestamp, lastDataUpdatedAt, lastCheckedAt)
 *   - Background ScheduledExecutorService that polls for a new all_issues.json
 *   - GET /api/status endpoint
 *   - POST /api/refresh endpoint (schedules a one-shot check after 60 s)
 *   - GET /api/issues now adds X-File-Modified-At and X-Server-Time response headers
 *     and injects _fileModifiedAt / _serverTime into the JSON payload
 *
 * HOW TO RUN:
 *   javac DashboardMiddleware.java
 *   java  DashboardMiddleware
 *
 * The server starts on http://localhost:8080 by default.
 * Set PORT env var to override.
 * Set MCP_ROOT env var to point to the project root (default: working dir).
 * Set PERIODIC_CHECK_SECONDS env var to override poll interval (default: 300).
 */
public class DashboardMiddleware {

    // ── Configuration ─────────────────────────────────────────────────────────

    private static final int PORT = Integer.parseInt(
            System.getenv().getOrDefault("PORT", "8080"));

    private static final Path PROJECT_ROOT = Paths.get(
            System.getenv().getOrDefault("MCP_ROOT", ".")).toAbsolutePath();

    private static final Path DATA_DIR   = PROJECT_ROOT.resolve("backend/data");
    private static final Path ISSUES_FILE = DATA_DIR.resolve("all_issues.json");

    /** How often the background thread checks for a new issues file (seconds) */
    private static final long PERIODIC_CHECK_SECONDS = Long.parseLong(
            System.getenv().getOrDefault("PERIODIC_CHECK_SECONDS", "300"));

    /** Delay for a one-shot check triggered by POST /api/refresh (seconds) */
    private static final long REFRESH_CHECK_DELAY_SECONDS = 60L;

    private static final java.util.Set<String> ALLOWED_CONFIGS = java.util.Set.of(
            "conf.ini",
            "mcpconf.properties",
            "apmconf.properties",
            "mapping.json",
            "category.json"
    );

    // ── ISO-8601 formatter ────────────────────────────────────────────────────

    private static final DateTimeFormatter ISO = DateTimeFormatter
            .ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'")
            .withZone(ZoneOffset.UTC);

    private static String toIso(Instant i) { return i == null ? null : ISO.format(i); }

    // ── Logging ───────────────────────────────────────────────────────────────

    private static final Logger LOG = Logger.getLogger("DashboardMiddleware");

    static {
        LogManager.getLogManager().reset();
        ConsoleHandler ch = new ConsoleHandler();
        ch.setLevel(Level.ALL);
        ch.setFormatter(new SimpleFormatter() {
            @Override public String format(LogRecord r) {
                return String.format("[%s] %s: %s%n", r.getLevel(), r.getLoggerName(), r.getMessage());
            }
        });
        LOG.addHandler(ch);
        LOG.setLevel(Level.INFO);
    }

    // ── Change 3 — In-memory metadata store ──────────────────────────────────

    /** File modification time at the moment data was last loaded onto the dashboard */
    private static volatile Instant lastFileTimestamp = null;

    /** Server wall-clock time when /api/issues last served data to the frontend */
    private static volatile Instant lastDataUpdatedAt = null;

    /** Server wall-clock time of the most recent periodic/one-shot file check */
    private static volatile Instant lastCheckedAt = null;

    /**
     * Set to true by the background thread when it finds a newer file.
     * Cleared to false when /api/issues is served (i.e. the frontend consumed it).
     */
    private static final AtomicBoolean hasNewData = new AtomicBoolean(false);

    /** Executor shared by the periodic check thread and one-shot refresh tasks */
    private static final ScheduledExecutorService scheduler =
            Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "file-watcher");
                t.setDaemon(true);
                return t;
            });

    /**
     * Compares the file's last-modified time to the stored lastFileTimestamp.
     * If newer, sets hasNewData = true and updates lastFileTimestamp.
     * Always updates lastCheckedAt.
     */
    private static void checkFile() {
        try {
            if (!Files.exists(ISSUES_FILE)) {
                lastCheckedAt = Instant.now();
                return;
            }
            FileTime ft = Files.getLastModifiedTime(ISSUES_FILE);
            Instant fileInstant = ft.toInstant();
            lastCheckedAt = Instant.now();

            if (lastFileTimestamp == null || fileInstant.isAfter(lastFileTimestamp)) {
                // Do NOT update lastFileTimestamp here.
                // Only IssuesHandler advances it after the frontend actually consumes
                // the file via GET /api/issues.  If we update it now, a second
                // checkFile() between this moment and the serve would see
                // fileInstant == lastFileTimestamp and silently drop the signal.
                hasNewData.set(true);
                LOG.info("checkFile → new data detected (file ts: " + toIso(fileInstant) + ")");
            }
        } catch (IOException e) {
            LOG.warning("checkFile error: " + e.getMessage());
        }
    }

    // ── Entry point ───────────────────────────────────────────────────────────

    public static void main(String[] args) throws IOException {
        LOG.info("Project root : " + PROJECT_ROOT);
        LOG.info("Data dir     : " + DATA_DIR);
        LOG.info("Issues file  : " + ISSUES_FILE);
        LOG.info("Check interval: " + PERIODIC_CHECK_SECONDS + " s");

        // Seed lastFileTimestamp silently at startup so the first periodic checkFile()
        // does not falsely detect the existing file as "new data".
        // We read the mod-time here WITHOUT setting hasNewData — the frontend will
        // load the file via its own boot GET /api/issues, which will set lastFileTimestamp.
        try {
            if (Files.exists(ISSUES_FILE)) {
                lastFileTimestamp = Files.getLastModifiedTime(ISSUES_FILE).toInstant();
                LOG.info("Startup seed: lastFileTimestamp = " + toIso(lastFileTimestamp));
            }
        } catch (IOException e) {
            LOG.warning("Startup seed failed: " + e.getMessage());
        }

        // Start the background periodic file-check (Change 3).
        // initialDelay = PERIODIC_CHECK_SECONDS (NOT 0) — first check fires after
        // one full interval, not immediately.  Prevents a race where checkFile()
        // runs before the frontend's initial GET /api/issues and spuriously sets
        // hasNewData=true on the file that was just seeded above.
        scheduler.scheduleAtFixedRate(
                DashboardMiddleware::checkFile,
                PERIODIC_CHECK_SECONDS,   // first check after one full interval
                PERIODIC_CHECK_SECONDS,
                TimeUnit.SECONDS
        );

        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 0);

        server.createContext("/api/issues",  new IssuesHandler());
        server.createContext("/api/status",  new StatusHandler());   // Change 3
        server.createContext("/api/refresh", new RefreshHandler());  // Change 3
        server.createContext("/api/config",  new ConfigHandler());

        server.setExecutor(Executors.newFixedThreadPool(4));
        server.start();

        LOG.info("DashboardMiddleware listening on http://localhost:" + PORT);
        LOG.info("  GET  /api/issues");
        LOG.info("  GET  /api/status");
        LOG.info("  POST /api/refresh");
        LOG.info("  GET  /api/config/<filename>");
        LOG.info("  PUT  /api/config/<filename>");
    }

    // ── Shared helpers ────────────────────────────────────────────────────────

    private static void addCors(HttpExchange ex) {
        ex.getResponseHeaders().set("Access-Control-Allow-Origin",  "*");
        ex.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
        ex.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type");
    }

    private static void send(HttpExchange ex, int status, String contentType, String body)
            throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", contentType);
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }

    private static void sendJson(HttpExchange ex, String json) throws IOException {
        send(ex, 200, "application/json; charset=utf-8", json);
    }

    private static void sendText(HttpExchange ex, String text) throws IOException {
        send(ex, 200, "text/plain; charset=utf-8", text);
    }

    private static void sendError(HttpExchange ex, int status, String message)
            throws IOException {
        String json = "{\"error\":\"" + message.replace("\"", "'") + "\"}";
        send(ex, status, "application/json; charset=utf-8", json);
    }

    private static String readBody(HttpExchange ex) throws IOException {
        try (InputStream is = ex.getRequestBody()) {
            return new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: GET /api/issues  (Change 3 — adds server timestamps to response)
    // ─────────────────────────────────────────────────────────────────────────

    static class IssuesHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1);
                return;
            }
            if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
                sendError(ex, 405, "Method not allowed");
                return;
            }

            Instant serverNow = Instant.now();

            if (Files.exists(ISSUES_FILE)) {
                String json = Files.readString(ISSUES_FILE, StandardCharsets.UTF_8);

                // Change 3 — update metadata.
                // lastCheckedAt is intentionally NOT updated here — only checkFile()
                // owns it.  Mixing it here caused the status bar to show the data-serve
                // time as the "last checked" time, which is semantically wrong.
                FileTime ft = Files.getLastModifiedTime(ISSUES_FILE);
                Instant fileInstant = ft.toInstant();
                lastFileTimestamp  = fileInstant;   // when the file was last written
                lastDataUpdatedAt  = serverNow;     // when the frontend loaded it
                hasNewData.set(false);              // frontend consumed the data

                // Add server-time response headers
                ex.getResponseHeaders().set("X-File-Modified-At", toIso(fileInstant));
                ex.getResponseHeaders().set("X-Server-Time",      toIso(serverNow));

                // Inject timestamps into the JSON payload so dashboard.js can
                // read them even when headers are stripped (e.g. by a proxy).
                // We append before the closing } of the top-level object.
                String stamped = injectTimestamps(json, fileInstant, serverNow);

                LOG.info("GET /api/issues → " + ISSUES_FILE.getFileName()
                        + " (" + stamped.length() + " bytes)");
                sendJson(ex, stamped);
            } else {
                LOG.warning("GET /api/issues → file not found: " + ISSUES_FILE);
                sendJson(ex, "{\"allIssues\":[]}");
            }
        }

        /**
         * Injects _fileModifiedAt and _serverTime into a top-level JSON object
         * string without a full parse.  Locates the last `}` and inserts before it.
         */
        private static String injectTimestamps(String json, Instant fileTs, Instant serverTs) {
            String fm = toIso(fileTs);
            String st = toIso(serverTs);
            String extra = ",\"_fileModifiedAt\":\"" + fm + "\",\"_serverTime\":\"" + st + "\"";
            int last = json.lastIndexOf('}');
            if (last < 0) return json + "{" + extra.substring(1) + "}";
            return json.substring(0, last) + extra + json.substring(last);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Change 3 — Handler: GET /api/status
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Returns current middleware metadata so the JS poller can decide whether
     * to pull fresh data.
     *
     * Response body:
     * {
     *   "lastFileModifiedAt": "2024-01-15T12:00:30Z",   // null if never loaded
     *   "lastDataUpdatedAt":  "2024-01-15T12:01:00Z",   // null if never served
     *   "lastCheckedAt":      "2024-01-15T12:06:00Z",   // null if never checked
     *   "hasNewData": false
     * }
     */
    static class StatusHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1);
                return;
            }
            if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
                sendError(ex, 405, "Method not allowed");
                return;
            }

            String json = "{"
                    + "\"lastFileModifiedAt\":" + jsonStr(toIso(lastFileTimestamp)) + ","
                    + "\"lastDataUpdatedAt\":"  + jsonStr(toIso(lastDataUpdatedAt)) + ","
                    + "\"lastCheckedAt\":"      + jsonStr(toIso(lastCheckedAt))     + ","
                    + "\"hasNewData\":"         + hasNewData.get()
                    + "}";

            LOG.fine("GET /api/status → " + json);
            sendJson(ex, json);
        }

        private static String jsonStr(String s) {
            return s == null ? "null" : "\"" + s + "\"";
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Change 3 — Handler: POST /api/refresh
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Tells the middleware that the Java fetch service has been triggered by
     * the user pressing the Refresh button.  Schedules a one-shot file check
     * after REFRESH_CHECK_DELAY_SECONDS (60 s) so the new file (if any) will
     * be detected by the next /api/status poll.
     *
     * Response: { "scheduled": true, "checkIn": 60 }
     */
    static class RefreshHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1);
                return;
            }
            if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
                sendError(ex, 405, "Method not allowed");
                return;
            }

            scheduler.schedule(
                    DashboardMiddleware::checkFile,
                    REFRESH_CHECK_DELAY_SECONDS,
                    TimeUnit.SECONDS
            );

            LOG.info("POST /api/refresh → one-shot check scheduled in "
                    + REFRESH_CHECK_DELAY_SECONDS + " s");

            sendJson(ex, "{\"scheduled\":true,\"checkIn\":" + REFRESH_CHECK_DELAY_SECONDS + "}");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: GET|PUT /api/config/:filename  (unchanged from original)
    // ─────────────────────────────────────────────────────────────────────────

    static class ConfigHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1);
                return;
            }

            String path   = ex.getRequestURI().getPath();
            String prefix = "/api/config/";
            if (!path.startsWith(prefix) || path.length() <= prefix.length()) {
                sendError(ex, 400, "Missing filename. Use /api/config/<filename>");
                return;
            }
            String filename = path.substring(prefix.length());

            if (filename.contains("..") || filename.contains("/") || filename.contains("\\")) {
                sendError(ex, 400, "Invalid filename");
                return;
            }
            if (!ALLOWED_CONFIGS.contains(filename)) {
                sendError(ex, 403, "Filename not allowed: " + filename
                        + ". Allowed: " + ALLOWED_CONFIGS);
                return;
            }

            Path file  = DATA_DIR.resolve(filename);
            String method = ex.getRequestMethod().toUpperCase();

            switch (method) {
                case "GET" -> handleConfigGet(ex, file, filename);
                case "PUT" -> handleConfigPut(ex, file, filename);
                default    -> sendError(ex, 405, "Method not allowed: " + method);
            }
        }

        private void handleConfigGet(HttpExchange ex, Path file, String filename)
                throws IOException {
            if (!Files.exists(file)) {
                LOG.warning("GET /api/config/" + filename + " → not found");
                sendError(ex, 404, "File not found: " + filename);
                return;
            }
            String content = Files.readString(file, StandardCharsets.UTF_8);
            LOG.info("GET /api/config/" + filename + " → " + content.length() + " bytes");
            sendText(ex, content);
        }

        private void handleConfigPut(HttpExchange ex, Path file, String filename)
                throws IOException {
            String body = readBody(ex);
            if (body.isBlank()) {
                sendError(ex, 400, "Empty body — nothing written");
                return;
            }
            Path tmp = file.resolveSibling(filename + ".tmp");
            Files.writeString(tmp, body, StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.ATOMIC_MOVE);
            LOG.info("PUT /api/config/" + filename + " → wrote " + body.length() + " bytes");
            send(ex, 200, "application/json; charset=utf-8",
                    "{\"ok\":true,\"file\":\"" + filename + "\"}");
        }
    }
}