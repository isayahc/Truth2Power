package com.truth2power.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;
import java.time.LocalDate;

/**
 * One assessment revision for a hospital, imported from data/&lt;id&gt;-*.json.
 * revision is the sha256 of the source file bytes — immutable per content, so a
 * re-import of the same file is a no-op. noncompliant_count is the count stated
 * in the source file; noncompliant_count_derived is the count derived from the
 * 17 measure fields (they differ for 2 hospitals in Wave 1 — see
 * HospitalImportService — and both are kept so the discrepancy stays visible).
 */
@Entity
@Table(name = "assessments", uniqueConstraints = @UniqueConstraint(name = "uq_assessments_hospital_revision", columnNames = {"hospital_id", "revision"}))
public class Assessment {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "hospital_id", nullable = false, length = 16)
    private String hospitalId;

    @Column(name = "revision", nullable = false, length = 64)
    private String revision;

    @Column(name = "grade", length = 1)
    private String grade;

    @Column(name = "stars")
    private Integer stars;

    @Column(name = "automatic_fail", nullable = false)
    private boolean automaticFail;

    @Column(name = "noncompliant_count")
    private Integer noncompliantCount;

    @Column(name = "noncompliant_count_derived")
    private Integer noncompliantCountDerived;

    @Column(name = "assessed_at")
    private LocalDate assessedAt;

    @Column(name = "source_row", nullable = false, columnDefinition = "JSON")
    private String sourceRow;

    public Assessment() {
    }

    public Long getId() {
        return id;
    }

    public String getHospitalId() {
        return hospitalId;
    }

    public void setHospitalId(String hospitalId) {
        this.hospitalId = hospitalId;
    }

    public String getRevision() {
        return revision;
    }

    public void setRevision(String revision) {
        this.revision = revision;
    }

    public String getGrade() {
        return grade;
    }

    public void setGrade(String grade) {
        this.grade = grade;
    }

    public Integer getStars() {
        return stars;
    }

    public void setStars(Integer stars) {
        this.stars = stars;
    }

    public boolean isAutomaticFail() {
        return automaticFail;
    }

    public void setAutomaticFail(boolean automaticFail) {
        this.automaticFail = automaticFail;
    }

    public Integer getNoncompliantCount() {
        return noncompliantCount;
    }

    public void setNoncompliantCount(Integer noncompliantCount) {
        this.noncompliantCount = noncompliantCount;
    }

    public Integer getNoncompliantCountDerived() {
        return noncompliantCountDerived;
    }

    public void setNoncompliantCountDerived(Integer noncompliantCountDerived) {
        this.noncompliantCountDerived = noncompliantCountDerived;
    }

    public LocalDate getAssessedAt() {
        return assessedAt;
    }

    public void setAssessedAt(LocalDate assessedAt) {
        this.assessedAt = assessedAt;
    }

    public String getSourceRow() {
        return sourceRow;
    }

    public void setSourceRow(String sourceRow) {
        this.sourceRow = sourceRow;
    }
}
