package com.truth2power.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.CommandLineRunner;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

/**
 * One-off Wave 1 import job (Phase 2). Runs only under the {@code import}
 * profile, together with the {@code tidb} profile that configures the
 * datasource. Example (from backend_2/):
 * SPRING_DATASOURCE_URL=jdbc:mysql://.../truth2power?sslMode=REQUIRED
 * SPRING_DATASOURCE_USERNAME=&lt;prefix&gt;.root
 * SPRING_DATASOURCE_PASSWORD=... mvn spring-boot:run
 * -Dspring-boot.run.profiles=tidb,import
 * Exits 0 after a successful import, 1 if the counts do not verify.
 */
@Component
@Profile("import")
public class ImportRunner implements CommandLineRunner {

    private static final Logger log = LoggerFactory.getLogger(ImportRunner.class);

    private final HospitalImportService importService;

    public ImportRunner(HospitalImportService importService) {
        this.importService = importService;
    }

    @Override
    public void run(String... args) throws Exception {
        log.info("Starting Wave 1 import (data/ -> TiDB)...");
        try {
            HospitalImportService.ImportSummary summary = importService.importAll();
            log.info("Wave 1 import complete: {} counties, {} hospitals, {} assessments, "
                    + "{} measure results, {} count mismatches (see warnings above). Exiting.",
                    summary.counties(), summary.hospitals(), summary.assessments(),
                    summary.measureResults(), summary.countMismatches().size());
            System.exit(0);
        } catch (Exception e) {
            log.error("Wave 1 import FAILED: {}", e.getMessage());
            System.exit(1);
        }
    }
}
