package com.truth2power.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.LocalDateTime;

/** One audit run (Phase 3 owns the lifecycle; the table is created in Phase 2). */
@Entity
@Table(name = "audit_runs")
public class AuditRun {

    @Id
    @Column(name = "id", nullable = false, length = 64)
    private String id;

    @Column(name = "hospital_id", length = 16)
    private String hospitalId;

    @Column(name = "kind", length = 64)
    private String kind;

    @Column(name = "status", length = 32)
    private String status;

    @Column(name = "started_at")
    private LocalDateTime startedAt;

    @Column(name = "finished_at")
    private LocalDateTime finishedAt;

    @Column(name = "log_path", length = 1024)
    private String logPath;

    public AuditRun() {
    }

    public AuditRun(String id) {
        this.id = id;
    }

    public String getId() {
        return id;
    }

    public String getHospitalId() {
        return hospitalId;
    }

    public void setHospitalId(String hospitalId) {
        this.hospitalId = hospitalId;
    }

    public String getKind() {
        return kind;
    }

    public void setKind(String kind) {
        this.kind = kind;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public LocalDateTime getStartedAt() {
        return startedAt;
    }

    public void setStartedAt(LocalDateTime startedAt) {
        this.startedAt = startedAt;
    }

    public LocalDateTime getFinishedAt() {
        return finishedAt;
    }

    public void setFinishedAt(LocalDateTime finishedAt) {
        this.finishedAt = finishedAt;
    }

    public String getLogPath() {
        return logPath;
    }

    public void setLogPath(String logPath) {
        this.logPath = logPath;
    }
}
