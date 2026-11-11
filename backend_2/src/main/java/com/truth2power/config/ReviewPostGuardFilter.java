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
 * Applies to POST requests whose path starts with /api/reviews/ (the old server
 * also guarded /api/pilot/, which Phase 3 ports). All must hold, else a bare
 * 403 with an empty body:
 * - Host is exactly 127.0.0.1:&lt;port&gt; or localhost:&lt;port&gt;;
 * - header x-review-request is exactly "1";
 * - if an Origin header is present, it is exactly http://127.0.0.1:&lt;port&gt;
 *   or http://localhost:&lt;port&gt;;
 * - body is at most 8192 bytes (413 if exceeded).
 * GET review routes have no guard. The server binds 127.0.0.1 only.
 */
@Component
@Order(1)
public class ReviewPostGuardFilter extends OncePerRequestFilter {

    private static final int MAX_REVIEW_BODY_BYTES = 8192;

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !"POST".equalsIgnoreCase(request.getMethod())
                || !request.getRequestURI().startsWith("/api/reviews/");
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
        int contentLength = request.getContentLength();
        if (contentLength > MAX_REVIEW_BODY_BYTES) {
            response.setStatus(413);
            return;
        }
        chain.doFilter(request, response);
    }
}
