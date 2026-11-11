package com.truth2power.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.math.BigDecimal;

/**
 * One hospital from data/maps/hospitals.geojson.
 * id is the NYSDOH PFI (e.g. "1002"). source_feature_json holds the original
 * GeoJSON feature verbatim so GET /api/hospitals can be reconstructed
 * byte-identically from the database.
 */
@Entity
@Table(name = "hospitals")
public class Hospital {

    @Id
    @Column(name = "id", nullable = false, length = 16)
    private String id;

    @Column(name = "name", nullable = false, length = 255)
    private String name;

    @Column(name = "slug", nullable = false, length = 255)
    private String slug;

    @Column(name = "county", nullable = false, length = 128)
    private String county;

    @Column(name = "address", length = 255)
    private String address;

    @Column(name = "city", length = 128)
    private String city;

    @Column(name = "state", nullable = false, length = 2)
    private String state = "NY";

    @Column(name = "zip_code", length = 16)
    private String zipCode;

    @Column(name = "latitude", precision = 10, scale = 7)
    private BigDecimal latitude;

    @Column(name = "longitude", precision = 10, scale = 7)
    private BigDecimal longitude;

    @Column(name = "grade", length = 1)
    private String grade;

    @Column(name = "stars")
    private Integer stars;

    @Column(name = "review_month", length = 7)
    private String reviewMonth;

    @Column(name = "record_path", length = 255)
    private String recordPath;

    @Column(name = "assistance_url", length = 1024)
    private String assistanceUrl;

    @Column(name = "audit_url", length = 1024)
    private String auditUrl;

    @Column(name = "website", length = 1024)
    private String website;

    @Column(name = "phone", length = 32)
    private String phone;

    @Column(name = "system_name", length = 255)
    private String systemName;

    @Column(name = "sort_order", nullable = false)
    private int sortOrder;

    @Column(name = "source_feature_json", nullable = false, columnDefinition = "TEXT")
    private String sourceFeatureJson;

    public Hospital() {
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getSlug() {
        return slug;
    }

    public void setSlug(String slug) {
        this.slug = slug;
    }

    public int getSortOrder() {
        return sortOrder;
    }

    public void setSortOrder(int sortOrder) {
        this.sortOrder = sortOrder;
    }

    public String getCounty() {
        return county;
    }

    public void setCounty(String county) {
        this.county = county;
    }

    public String getAddress() {
        return address;
    }

    public void setAddress(String address) {
        this.address = address;
    }

    public String getCity() {
        return city;
    }

    public void setCity(String city) {
        this.city = city;
    }

    public String getState() {
        return state;
    }

    public void setState(String state) {
        this.state = state;
    }

    public String getZipCode() {
        return zipCode;
    }

    public void setZipCode(String zipCode) {
        this.zipCode = zipCode;
    }

    public BigDecimal getLatitude() {
        return latitude;
    }

    public void setLatitude(BigDecimal latitude) {
        this.latitude = latitude;
    }

    public BigDecimal getLongitude() {
        return longitude;
    }

    public void setLongitude(BigDecimal longitude) {
        this.longitude = longitude;
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

    public String getReviewMonth() {
        return reviewMonth;
    }

    public void setReviewMonth(String reviewMonth) {
        this.reviewMonth = reviewMonth;
    }

    public String getRecordPath() {
        return recordPath;
    }

    public void setRecordPath(String recordPath) {
        this.recordPath = recordPath;
    }

    public String getAssistanceUrl() {
        return assistanceUrl;
    }

    public void setAssistanceUrl(String assistanceUrl) {
        this.assistanceUrl = assistanceUrl;
    }

    public String getAuditUrl() {
        return auditUrl;
    }

    public void setAuditUrl(String auditUrl) {
        this.auditUrl = auditUrl;
    }

    public String getWebsite() {
        return website;
    }

    public void setWebsite(String website) {
        this.website = website;
    }

    public String getPhone() {
        return phone;
    }

    public void setPhone(String phone) {
        this.phone = phone;
    }

    public String getSystemName() {
        return systemName;
    }

    public void setSystemName(String systemName) {
        this.systemName = systemName;
    }

    public String getSourceFeatureJson() {
        return sourceFeatureJson;
    }

    public void setSourceFeatureJson(String sourceFeatureJson) {
        this.sourceFeatureJson = sourceFeatureJson;
    }
}
