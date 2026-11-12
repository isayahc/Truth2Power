package com.truth2power.service;

import com.truth2power.config.RepoPaths;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * The audit engine as a managed sidecar (plan §3.1): {@code backend_2}
 * launches {@code node backend/audit/worker.js} as a child process on boot,
 * watches it, restarts it once on crash, and shuts it down cleanly when
 * Spring stops. One command starts the whole backend — no second terminal.
 *
 * <p>The worker code itself is untouched (same queue, same {@code .audit/}
 * store, same Python grader calls). Environment passed through:
 * {@code PORT} (defaults to this server's port, so the worker's demo audit
 * fetches the fixture from {@code backend_2} itself), {@code AUDIT_DIR}
 * (defaults to the resolved audit directory), {@code T2P_PYTHON}.
 *
 * <p>A missing node binary or worker file is a warning, not a boot failure:
 * the atlas and review surfaces keep working, and audit runs stay queued
 * until an operator starts the worker by hand.
 */
@Service
public class AuditWorkerSupervisor {

    private static final Logger log = LoggerFactory.getLogger(AuditWorkerSupervisor.class);

    private final RepoPaths paths;
    private final boolean enabled;
    private final int serverPort;

    private volatile Process worker;
    private volatile boolean stopping;
    private volatile int restarts;
    private Thread watcher;

    public AuditWorkerSupervisor(RepoPaths paths,
                                 @Value("${t2p.audit-worker.enabled:true}") boolean enabled,
                                 @Value("${server.port:8080}") int serverPort) {
        this.paths = paths;
        this.enabled = enabled;
        this.serverPort = serverPort;
    }

    @PostConstruct
    public void start() {
        if (!enabled) {
            log.info("Audit worker supervision disabled (t2p.audit-worker.enabled=false).");
            return;
        }
        Path workerScript = paths.repoRoot().resolve("backend/audit/worker.js");
        if (!Files.exists(workerScript)) {
            log.warn("Audit worker not started: {} does not exist in this checkout.", workerScript);
            return;
        }
        if (!nodeAvailable()) {
            log.warn("Audit worker not started: 'node' is not on PATH. "
                    + "Audit runs will stay queued until the worker is started by hand.");
            return;
        }
        launch();
        watcher = new Thread(this::watch, "audit-worker-watcher");
        watcher.setDaemon(true);
        watcher.start();
    }

    private boolean nodeAvailable() {
        try {
            Process p = new ProcessBuilder("node", "--version")
                    .redirectErrorStream(true).start();
            return p.waitFor(10, TimeUnit.SECONDS) && p.exitValue() == 0;
        } catch (IOException | InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private synchronized void launch() {
        if (stopping) {
            return;
        }
        List<String> command = new ArrayList<>();
        command.add("node");
        command.add(paths.repoRoot().resolve("backend/audit/worker.js").toString());
        ProcessBuilder pb = new ProcessBuilder(command);
        pb.directory(paths.repoRoot().toFile());
        pb.environment().putIfAbsent("PORT", String.valueOf(serverPort));
        pb.environment().putIfAbsent("AUDIT_DIR", paths.auditDir().toString());
        // Default the worker's Python to python3 when T2P_PYTHON is unset:
        // the old code defaults to "python", which does not exist on macOS
        // or in this sandbox (only python3 does). An explicit T2P_PYTHON
        // is always honoured.
        pb.environment().putIfAbsent("T2P_PYTHON", "python3");
        pb.inheritIO();
        try {
            worker = pb.start();
            log.info("Audit worker started (pid {}, PORT={}, AUDIT_DIR={}).",
                    worker.pid(), pb.environment().get("PORT"), pb.environment().get("AUDIT_DIR"));
        } catch (IOException e) {
            log.warn("Could not start the audit worker: {}", e.getMessage());
            worker = null;
        }
    }

    private void watch() {
        while (!stopping) {
            Process current;
            synchronized (this) {
                current = worker;
            }
            if (current == null) {
                return;
            }
            try {
                int exit = current.waitFor();
                if (stopping) {
                    return;
                }
                log.warn("Audit worker exited with code {}.", exit);
                if (restarts < 1) {
                    restarts++;
                    log.info("Restarting the audit worker (restart 1 of 1).");
                    launch();
                } else {
                    log.error("Audit worker exited again; not restarting. "
                            + "Queued runs will wait until the worker is started by hand "
                            + "(npm run audit:worker) or backend_2 is restarted.");
                    return;
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    /** True when the supervised worker process is currently alive. */
    public boolean isRunning() {
        Process current = worker;
        return current != null && current.isAlive();
    }

    @PreDestroy
    public void stop() {
        stopping = true;
        Process current;
        synchronized (this) {
            current = worker;
        }
        if (current != null && current.isAlive()) {
            log.info("Stopping the audit worker (pid {}).", current.pid());
            current.destroy();
            try {
                if (!current.waitFor(10, TimeUnit.SECONDS)) {
                    current.destroyForcibly();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                current.destroyForcibly();
            }
        }
        if (watcher != null) {
            watcher.interrupt();
        }
    }
}
