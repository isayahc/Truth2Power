package com.truth2power.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;

/**
 * One of the 17 rubric measures (rubrics/css-17-v1.json) for one assessment.
 * status is one of yes / no / unclear / n_a, derived from the Wave 1 hospital
 * JSON by HospitalImportService (see its MEASURE_FIELDS mapping).
 */
@Entity
@Table(name = "measure_results", uniqueConstraints = @UniqueConstraint(name = "uq_measure_results", columnNames = {"assessment_id", "measure_id"}))
public class MeasureResult {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "assessment_id", nullable = false)
    private Long assessmentId;

    @Column(name = "measure_id", nullable = false, length = 128)
    private String measureId;

    @Column(name = "css_column", length = 2)
    private String cssColumn;

    @Column(name = "status", nullable = false, length = 16)
    private String status;

    @Column(name = "evidence_ref", length = 1024)
    private String evidenceRef;

    public MeasureResult() {
    }

    public MeasureResult(Long assessmentId, String measureId, String cssColumn, String status, String evidenceRef) {
        this.assessmentId = assessmentId;
        this.measureId = measureId;
        this.cssColumn = cssColumn;
        this.status = status;
        this.evidenceRef = evidenceRef;
    }

    public Long getId() {
        return id;
    }

    public Long getAssessmentId() {
        return assessmentId;
    }

    public String getMeasureId() {
        return measureId;
    }

    public String getCssColumn() {
        return cssColumn;
    }

    public String getStatus() {
        return status;
    }

    public String getEvidenceRef() {
        return evidenceRef;
    }
}
