package com.truth2power.repository;

import com.truth2power.model.Assessment;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AssessmentRepository extends JpaRepository<Assessment, Long> {

    Optional<Assessment> findByHospitalIdAndRevision(String hospitalId, String revision);

    long countByHospitalId(String hospitalId);
}
