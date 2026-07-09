import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.concurrent.Executors;
import java.util.logging.*;

/**
 * DashboardMiddleware — Unified MCP Dashboard backend.
 *
 * Exposes three REST endpoints consumed by the HTML/JS frontend:
 *
 *   GET  /api/issues              → serves backend/data/all_issues.json (raw)
 *   GET  /api/config/:filename    → reads  backend/data/<filename> as text
 *   PUT  /api/config/:filename    → writes backend/data/<filename> from request body
 *
 * Supported config filenames:
 *   conf.ini  |  mcpconf.properties  |  apmconf.properties
 *   mapping.json  |  category.json
 *
 * HOW TO RUN (no build tool needed):
 *   javac DashboardMiddleware.java
 *   java  DashboardMiddleware
 *
 * The server starts on http://localhost:8080 by default.
 * Set the PORT environment variable to override.
 *
 * After starting, edit api.js:
 *   const BASE_URL = "http://localhost:8080";
 */
public class DashboardMiddleware {

    // ── Configuration ────────────────────────────────────────────────────────

    /** HTTP port — override with env var PORT */
    private static final int PORT = Integer.parseInt(
            System.getenv().getOrDefault("PORT", "8080"));

    /**
     * Root directory of the project (where backend/ and frontend/ live).
     * Defaults to the working directory where you run java.
     * Override with env var MCP_ROOT, e.g. MCP_ROOT=/home/user/project.
     */
    private static final Path PROJECT_ROOT = Paths.get(
            System.getenv().getOrDefault("MCP_ROOT", ".")).toAbsolutePath();

    /** Directory that holds all_issues.json and config files */
    private static final Path DATA_DIR = PROJECT_ROOT.resolve("backend/data");

    /** The issues file served by GET /api/issues */
    private static final Path ISSUES_FILE = DATA_DIR.resolve("all_issues.json");

    /** Allowed config filenames for GET/PUT /api/config/:filename */
    private static final java.util.Set<String> ALLOWED_CONFIGS = java.util.Set.of(
            "conf.ini",
            "mcpconf.properties",
            "apmconf.properties",
            "mapping.json",
            "category.json"
    );

    // ── Logging ──────────────────────────────────────────────────────────────

    private static final Logger LOG = Logger.getLogger("DashboardMiddleware");

    static {
        // Simple console logger — replace with a file handler if needed
        LogManager.getLogManager().reset();
        ConsoleHandler ch = new ConsoleHandler();
        ch.setLevel(Level.ALL);
        ch.setFormatter(new SimpleFormatter() {
            @Override
            public String format(LogRecord r) {
                return String.format("[%s] %s: %s%n",
                        r.getLevel(), r.getLoggerName(), r.getMessage());
            }
        });
        LOG.addHandler(ch);
        LOG.setLevel(Level.INFO);
    }

    // ── Entry point ──────────────────────────────────────────────────────────

    public static void main(String[] args) throws IOException {
        LOG.info("Project root : " + PROJECT_ROOT);
        LOG.info("Data dir     : " + DATA_DIR);
        LOG.info("Issues file  : " + ISSUES_FILE);

        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 0);

        // GET /api/issues
        server.createContext("/api/issues", new IssuesHandler());

        // GET|PUT /api/config/:filename
        server.createContext("/api/config", new ConfigHandler());

        // Thread pool — handles concurrent requests
        server.setExecutor(Executors.newFixedThreadPool(4));
        server.start();

        LOG.info("DashboardMiddleware listening on http://localhost:" + PORT);
        LOG.info("  GET  /api/issues");
        LOG.info("  GET  /api/config/<filename>");
        LOG.info("  PUT  /api/config/<filename>");
    }

    // ── Shared helpers ───────────────────────────────────────────────────────

    /**
     * Adds CORS headers so the browser (served from file:// or a different
     * origin) can reach the backend without proxy setup.
     */
    private static void addCors(HttpExchange ex) {
        ex.getResponseHeaders().set("Access-Control-Allow-Origin",  "*");
        ex.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
        ex.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type");
    }

    /**
     * Sends a plain-text or JSON response.
     *
     * @param ex          the exchange
     * @param status      HTTP status code
     * @param contentType e.g. "application/json; charset=utf-8"
     * @param body        response body string
     */
    private static void send(HttpExchange ex, int status, String contentType, String body)
            throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", contentType);
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    /** Convenience: 200 JSON response */
    private static void sendJson(HttpExchange ex, String json) throws IOException {
        send(ex, 200, "application/json; charset=utf-8", json);
    }

    /** Convenience: 200 plain-text response */
    private static void sendText(HttpExchange ex, String text) throws IOException {
        send(ex, 200, "text/plain; charset=utf-8", text);
    }

    /** Convenience: error response */
    private static void sendError(HttpExchange ex, int status, String message)
            throws IOException {
        String json = "{\"error\":\"" + message.replace("\"", "'") + "\"}";
        send(ex, status, "application/json; charset=utf-8", json);
    }

    /** Reads the full request body as a UTF-8 string */
    private static String readBody(HttpExchange ex) throws IOException {
        try (InputStream is = ex.getRequestBody()) {
            return new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: GET /api/issues
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Serves the content of backend/data/all_issues.json.
     *
     * The frontend (dashboard.js) calls GET /api/issues and expects the raw
     * JSON object: { "allIssues": [ ... ] }
     *
     * If the file is missing, returns { "allIssues": [] } so the UI shows
     * an empty table rather than crashing.
     */
    static class IssuesHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);

            // Handle CORS pre-flight
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1);
                return;
            }

            if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
                sendError(ex, 405, "Method not allowed");
                return;
            }

            if (Files.exists(ISSUES_FILE)) {
                String json = Files.readString(ISSUES_FILE, StandardCharsets.UTF_8);
                LOG.info("GET /api/issues → " + ISSUES_FILE.getFileName()
                        + " (" + json.length() + " bytes)");
                sendJson(ex, json);
            } else {
                LOG.warning("GET /api/issues → file not found: " + ISSUES_FILE);
                sendJson(ex, "{\"allIssues\":[]}");
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: GET|PUT /api/config/:filename
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * GET  /api/config/conf.ini         → returns file content as plain text
     * PUT  /api/config/conf.ini         → overwrites file with request body
     *
     * Only filenames in ALLOWED_CONFIGS are served/written.
     * Path traversal (../) is rejected.
     */
    static class ConfigHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);

            // Handle CORS pre-flight
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1);
                return;
            }

            // Extract filename from path: /api/config/conf.ini → conf.ini
            String path = ex.getRequestURI().getPath(); // e.g. /api/config/conf.ini
            String prefix = "/api/config/";
            if (!path.startsWith(prefix) || path.length() <= prefix.length()) {
                sendError(ex, 400, "Missing filename. Use /api/config/<filename>");
                return;
            }
            String filename = path.substring(prefix.length());

            // Security: reject path traversal and disallowed names
            if (filename.contains("..") || filename.contains("/") || filename.contains("\\")) {
                sendError(ex, 400, "Invalid filename");
                return;
            }
            if (!ALLOWED_CONFIGS.contains(filename)) {
                sendError(ex, 403, "Filename not allowed: " + filename
                        + ". Allowed: " + ALLOWED_CONFIGS);
                return;
            }

            Path file = DATA_DIR.resolve(filename);
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

            // Write atomically: write to .tmp then move, so a read mid-write
            // never sees a half-written file.
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
