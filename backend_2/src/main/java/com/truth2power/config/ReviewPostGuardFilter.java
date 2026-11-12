package com.truth2power.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Layer A of the review POST guard — port of backend/src/local-server.js:54-71.
 * Applies to POST requests whose path starts with /api/reviews/ or /api/pilot/
 * (the old server guarded both). All must hold, else a bare 403 with an empty
 * body:
 * - Host is exactly 127.0.0.1:&lt;port&gt; or localhost:&lt;port&gt;;
 * - header x-review-request is exactly "1";
 * - if an Origin header is present, it is exactly http://127.0.0.1:&lt;port&gt;
 *   or http://localhost:&lt;port&gt;;
 * - body is at most 8192 bytes (413 if exceeded), except the intervention
 *   documents upload, which gets 6 MB.
 * GET routes have no guard. The server binds 127.0.0.1 only. (The
 * /api/audits/362 POST has its own inline guard and is not covered here.)
 */
@Component
@Order(1)
public class ReviewPostGuardFilter extends OncePerRequestFilter {

    private static final int MAX_REVIEW_BODY_BYTES = 8192;
    private static final int MAX_DOCUMENT_BODY_BYTES = 6 * 1024 * 1024;
    private static final java.util.regex.Pattern INTERVENTION_DOCUMENTS =
            java.util.regex.Pattern.compile("^/api/pilot/v1/runs/audit-run-[1-9]\\d*/intervention/documents$");

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String uri = request.getRequestURI();
        return !"POST".equalsIgnoreCase(request.getMethod())
                || (!uri.startsWith("/api/reviews/") && !uri.startsWith("/api/pilot/"));
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String host = request.getHeader("Host");
        int port = request.getLocalPort();
        boolean hostOk = ("127.0.0.1:" + port).equals(host) || ("localhost:" + port).equals(host);
        boolean headerOk = "1".equals(request.getHeader("x-review-request"));
        String origin = request.getHeader("Origin");
        boolean originOk = origin == null
                || ("http://127.0.0.1:" + port).equals(origin)
                || ("http://localhost:" + port).equals(origin);
        if (!hostOk || !headerOk || !originOk) {
            response.setStatus(HttpServletResponse.SC_FORBIDDEN);
            return;
        }
        int limit = INTERVENTION_DOCUMENTS.matcher(request.getRequestURI()).matches()
                ? MAX_DOCUMENT_BODY_BYTES : MAX_REVIEW_BODY_BYTES;
        int contentLength = request.getContentLength();
        if (contentLength > limit) {
            response.setStatus(413);
            return;
        }
        chain.doFilter(request, response);
    }
}
