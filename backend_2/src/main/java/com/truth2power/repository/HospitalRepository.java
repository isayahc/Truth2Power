package com.truth2power.repository;

import com.truth2power.model.Hospital;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface HospitalRepository extends JpaRepository<Hospital, String> {

    List<Hospital> findAllByOrderByIdAsc();

    /** Roster order: the geojson feature order, preserved by sort_order. */
    List<Hospital> findAllByOrderBySortOrderAsc();

    @Query("select distinct h.county from Hospital h order by h.county")
    List<String> findDistinctCounties();
}
