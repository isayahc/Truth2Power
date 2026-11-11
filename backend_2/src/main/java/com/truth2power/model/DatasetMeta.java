package com.truth2power.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** One dataset-level metadata entry (see dataset_meta in V1). */
@Entity
@Table(name = "dataset_meta")
public class DatasetMeta {

    @Id
    @Column(name = "meta_key", nullable = false, length = 128)
    private String key;

    @Column(name = "meta_value", columnDefinition = "TEXT")
    private String value;

    public DatasetMeta() {
    }

    public DatasetMeta(String key, String value) {
        this.key = key;
        this.value = value;
    }

    public String getKey() {
        return key;
    }

    public void setKey(String key) {
        this.key = key;
    }

    public String getValue() {
        return value;
    }

    public void setValue(String value) {
        this.value = value;
    }
}
