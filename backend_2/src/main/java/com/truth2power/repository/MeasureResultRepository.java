package com.truth2power.repository;

import com.truth2power.model.MeasureResult;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface MeasureResultRepository extends JpaRepository<MeasureResult, Long> {

    List<MeasureResult> findByAssessmentIdOrderByMeasureIdAsc(Long assessmentId);

    long countByAssessmentId(Long assessmentId);
}
