package com.truth2power.repository;

import com.truth2power.model.AuditRun;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AuditRunRepository extends JpaRepository<AuditRun, String> {
}
