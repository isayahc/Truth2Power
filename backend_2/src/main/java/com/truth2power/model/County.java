package com.truth2power.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** One NY county, with its economic region (references/ny-economic-regions-v1.json). */
@Entity
@Table(name = "counties")
public class County {

    @Id
    @Column(name = "name", nullable = false, length = 128)
    private String name;

    @Column(name = "region", length = 128)
    private String region;

    public County() {
    }

    public County(String name, String region) {
        this.name = name;
        this.region = region;
    }

    public String getName() {
        return name;
    }

    public String getRegion() {
        return region;
    }

    public void setRegion(String region) {
        this.region = region;
    }
}
