package com.truth2power.service;

/**
 * An audit-route failure carrying the exact status + code/sentence the old
 * app returns. Controllers map it to the route's own error envelope
 * (reporting-api machine codes with {@code schema_version}, pipeline/grading
 * plain sentences, intervention codes without {@code schema_version}).
 */
public class AuditException extends RuntimeException {

    public final int status;
    public final String code;

    public AuditException(int status, String code) {
        super(code);
        this.status = status;
        this.code = code;
    }

    public static AuditException fail(int status, String code) {
        return new AuditException(status, code);
    }
}
