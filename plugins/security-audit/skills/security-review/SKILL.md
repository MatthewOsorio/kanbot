---
name: security-review
description: >
  Security review of one ticket's branch diff: trace untrusted input in the changed code to dangerous
  sinks, check access control, secrets, file and resource handling, business logic and the obvious
  exposures. Read-only guidance: writes no files, runs no target code. Use for the security check of
  a code review.
---

# Security review of a branch diff

This skill is the guidance mode of Cloudflare's `security-audit` skill (MIT; see the plugin's LICENSE),
cut down for reviewing one branch. Everything after "Source material" is copied verbatim from it.

## How to use it in a code review

1. Scope: the branch diff (`git diff <base>...HEAD`) and the code it calls or is called by. Not the
   whole repository.
2. For each changed entry point (route, handler, CLI argument, file read, message, agent tool),
   name the lower-trust principal and trace its input through the diff to any dangerous sink.
3. Walk the attack classes below that apply to what the diff touches. Skip classes it doesn't touch.
   The source material mentions sub-agents (`subagent_type`) and companion files: ignore both. You
   review alone, and the companion classes for web and client-side code are included below.
4. Static source review only. Do not run the target's code beyond the commands you are already
   allowed, do not create files, and do not probe anything over the network.
5. Report only what meets the bar in "Core principles": a concrete principal, boundary and result.
   - A **finding** this branch introduces or makes reachable, with a source trace: a blocking review
     comment on the file and line, with the smallest fix and a regression test to add.
   - A plausible issue whose decisive fact is outside the source (deployment, proxy, provider): a
     non-blocking comment that names the missing fact.
   - Hardening advice with no reachable boundary violation is not a finding: leave it out, or one
     non-blocking comment at most.
   - Issues that already existed before this branch and that the diff doesn't touch: not this
     ticket's problem. Mention them in the review artifact, not as blocking comments.

## Source material

## Core principles

### Require a boundary and result

For every candidate, name the lower-trust principal, accepted input or action, intended control, crossed boundary, affected principal or resource, and concrete observed or owner-observable result. Do not elevate a missing best practice, guessed deployment behavior, generic parser crash, or self-impact into a security finding.

### Use bounded local evidence

Static analysis establishes the source path. Sandboxed local tests resolve behavior when all execution controls are available: a minimal function harness, existing unit test, small parser fixture, dummy-tenant integration test, locally rendered configuration, or bounded isolated-loopback client. Stop at a wrong return value, unauthorized dummy record, sanitizer finding, policy difference, or other minimum effect. Do not extend the local check beyond the minimum boundary result or produce persistence, post-fault, or concealment material.

### Respect source visibility

Deployment controls, proxy behavior, provider settings, browser headers, identity policy, broker ACLs, packaging, and topology are real controls. If they are required and absent from the repository, do not assume either presence or absence. Use `needs_validation` with the exact missing fact and a safe owner-observed or local plan.

### Separate priority from certainty

Only `confirmed` records receive severity. Likelihood and impact must reflect the demonstrated conditions and result; overall severity cannot exceed demonstrated impact. `needs_validation` means a specific source-grounded boundary hypothesis is blocked, not a low-confidence confirmed vulnerability, and it has no severity.

Calibrate overall severity with these anchors:

- **critical** — an unauthenticated actor gains code execution, full data-store access, or takeover of arbitrary accounts.
- **high** — an actor fully defeats an explicit security control with real consequences: authentication bypass, cross-tenant read or write, stored script execution affecting other users, authenticated code execution, or an unauthenticated remote stop of a shared service.
- **medium** — a real boundary violation with limited blast radius, uncommon preconditions, or consequences confined to a narrow resource set.
- **low** — disclosure of non-secret internals, or an effect requiring sustained effort for minimal gain.
- **informational** — a confirmed but minimal-impact observation, useful mainly as a prerequisite inside a larger finding.

The high/medium discriminator: does the demonstrated result fully defeat an explicit control for an action with real consequences, or only weaken it? If you cannot state the concrete damage, the severity is lower than it feels.

### Recommend the smallest effective source fix

For each confirmed finding, identify the invariant the code must enforce and the narrowest source change that enforces it at the last trusted decision point. Prefer specific repository-relative changes and regression tests over generic hardening advice. The audit describes fixes; it does not modify target source.

## Anti-patterns

1. Checklist deviations presented as vulnerabilities.
2. Defense-in-depth advice with no reachable boundary violation.
3. Live or shared-environment testing where bounded local evidence is insufficient.
4. Guessing provider, proxy, browser, identity, or deployment behavior not present in source.
5. Treating intended same-principal authority or self-impact as a cross-boundary result.
6. Reporting a parser or runtime effect stronger than the observed effect.
7. Emitting prose-only hunter results that cannot be deduplicated or verified.
8. Re-reporting carried same-source prior confirmed records or using them as exemplars that anchor the hunt.
9. Assigning severity to `needs_validation` records.
10. Writing the report before independent verification or letting prose and JSON disagree.

# Attack Classes

#### Attack classes — choose and split based on Phase 1

Select attack classes relevant to the application type. Not every class applies to every codebase. The list below is a starting point; add application-specific classes from Phase 1 and split large codebases per subsystem. Frame work as finding, validating, fixing, and prioritizing vulnerabilities. Keep validation to source review and bounded local fixtures; do not develop payload chains, test availability on live services, or take action in shared environments.

Use `confirmed` only when source evidence and bounded validation establish the full boundary and meaningful result. Use `needs_validation` when a specific deployment, provider, platform, identity, or runtime fact is unavailable; state the missing fact and the safe owner-observed or local check that resolves it.

> **Native / binary / kernel targets** (C/C++/Rust-unsafe, kernel modules, parsers and decoders, FFI, concurrent runtimes, binary loaders, JITs, firmware): use the memory-safety, integer/ABI, concurrency, binary-loader, and privileged-interface classes in [MEMORY-SAFETY-AND-BINARY.md](MEMORY-SAFETY-AND-BINARY.md).
>
> **AI / LLM / agent targets** (chatbots, RAG, persistent memory, tool-calling agents, MCP servers/clients, prompt assembly, or model-controlled actions): use the context, memory-poisoning, action-binding, tool-schema, MCP-identity, and output classes in [AI-AND-LLM.md](AI-AND-LLM.md).
>
> **HTTP, web, and identity targets** (ordinary web apps, APIs, reverse proxies, CDNs, gateways, custom HTTP parsers, sessions, CSRF, JWT, OAuth/OIDC, SAML, MFA, passkeys, account recovery/linking, API keys, or mTLS): use [WEB-PROTOCOL-AND-AUTH.md](WEB-PROTOCOL-AND-AUTH.md).
>
> **Client-side and browser targets** (SPAs, browser extensions, embedded webviews, service workers, browser storage, cross-window messaging, CORS, WebSockets, or DOM rendering): use [CLIENT-SIDE.md](CLIENT-SIDE.md).
>
> **Supply-chain and release targets** (dependency resolution, generated inputs, CI, release/signing/promotion, updates, plugins, or extensions): use [SUPPLY-CHAIN-AND-RELEASE.md](SUPPLY-CHAIN-AND-RELEASE.md).
>
> **Cloud and deployment targets** (IAM, infrastructure as code, containers/Kubernetes, service mesh, serverless/edge, ingress, provider events, or runtime configuration): use [CLOUD-AND-DEPLOYMENT.md](CLOUD-AND-DEPLOYMENT.md).
>
> **Protocol, RPC, and messaging targets** (gRPC, GraphQL transports, Protobuf/Cap'n Proto/Thrift, custom protocols, queues, brokers, pub/sub, webhooks, or streaming RPC): use [PROTOCOLS-RPC-AND-MESSAGING.md](PROTOCOLS-RPC-AND-MESSAGING.md).
>
> **Resource-exhaustion and availability targets** (untrusted work can consume shared CPU, memory, disk, connections, workers, queues, quotas, or operator-owned spend): use [RESOURCE-EXHAUSTION-AND-AVAILABILITY.md](RESOURCE-EXHAUSTION-AND-AVAILABILITY.md).
>
> **Data-isolation and lifecycle targets** (multi-tenant stores, caches/search, object links, analytics, export/backup, migration, deletion, retention, or restore): use [DATA-ISOLATION-AND-LIFECYCLE.md](DATA-ISOLATION-AND-LIFECYCLE.md).
>
> **Desktop, mobile, and local-IPC targets** (native apps, deep links, webview bridges, exported components, privileged helpers, local daemons, Unix sockets/XPC/Binder/D-Bus): use [DESKTOP-MOBILE-AND-LOCAL-IPC.md](DESKTOP-MOBILE-AND-LOCAL-IPC.md).

**Injection** (subagent_type: `general`)
Trace untrusted input from entry point to dangerous sink. What counts as a "dangerous sink" depends on the application:
- Web apps: SQL queries, HTML output, shell commands, template engines, file paths, HTTP redirects, deserialization
- Libraries: any function that processes caller-supplied data without validation — buffer operations, parsers, format strings
- CLI tools: shell command construction, file path handling, environment variable interpolation
- Services: query construction, message serialization, log injection, LDAP/XPATH queries
- Client-side (browser/JS): DOM XSS, prototype pollution, `postMessage`/origin trust, and other browser-side classes — covered by the [CLIENT-SIDE.md](CLIENT-SIDE.md) companion blocks when selected

Do not stop at the obvious direct paths. Look for indirect injection: data stored safely, then retrieved and used in a dangerous context by different code. Look for injection through field names, keys, headers, and metadata — not just values. Look for injection into secondary systems (logs, caches, search indexes, analytics).

**Access control** (subagent_type: `general`)
Verify that a caller cannot do something outside its authority. Go beyond checking whether permission checks exist — verify they check the *right* permission for the *right* resource via the *right* mechanism:
- Is there a path to the same state change that checks a different (weaker) permission?
- Can a field in the request body override what the permission system intended to restrict?
- Are there endpoints that gate on authentication but forget authorization?
- Does the same resource have multiple access paths with inconsistent checks?
- What about bulk/batch/export/import operations — do they enforce per-item permissions?

For complex access models, split into separate agents for auth bypass vs authorization logic.

**Resource and file handling** (subagent_type: `general`)
- Path traversal (reading/writing outside intended directories) — including through symlinks, encoded sequences, and null bytes
- SSRF (making the application fetch attacker-controlled URLs) — including through redirects, DNS rebinding, and URL parser differentials
- Unsafe deserialization, archive extraction (zip slip), temp file handling
- Memory safety (if applicable): buffer overflows, use-after-free, integer overflow
- Race conditions on file operations (TOCTOU between check and use)

**Cryptography and secrets** (subagent_type: `general`)
- Weak randomness for security-critical values (tokens, keys, nonces)
- Hardcoded secrets, secrets in logs, error messages, URLs, or client-visible responses
- Broken key derivation, missing HMAC verification, nonce reuse
- Timing side-channels on secret comparison
- Misuse of crypto primitives (ECB mode, unauthenticated encryption, static IVs, etc.)
- What happens when crypto operations fail? Does the error path fall back to no-crypto?

**Business logic** (subagent_type: `general`)
Hunt logic errors by hand: standard scanners cannot find them, and they yield high-impact findings. For each major workflow:
- **State machine violations**: Can you skip steps? Go backwards? Reach an invalid state? What happens if you replay a completed flow? What about partial failure — if step 2 of 3 fails, is step 1 rolled back?
- **Race conditions with business impact**: Concurrent operations that produce invalid states (double-spend, double-approve, lost updates). Focus on operations that check-then-act non-atomically.
- **Numeric/quantity manipulation**: Negative values, zero values, overflow, precision loss, type coercion between string and number.
- **Access boundary violations**: Not "does the permission check exist" but "is it the right check for the business rule?" Can input to one operation bypass a restriction enforced on a different operation for the same effect?
- **Implicit trust assumptions**: Data from storage, config, other components, or plugins assumed safe because "we validated it on the way in." What if a different code path wrote it?
- **Time-based logic**: Expiry checks, scheduling, rate windows, clock skew. What happens at exact boundary moments? What about timezone differences between components?
- **Default and fallback behavior**: What is the security posture when config is missing? When a feature flag is off? When a dependency is unavailable? When the system is mid-migration?

**Feature abuse and data leakage** (subagent_type: `general`)
Legitimate features used for unintended purposes. Look for bugs in the design, not only in the code:
- **Export/backup as exfiltration**: Can a low-privilege user trigger an export, snapshot, or backup that includes data above their access level? Can they export other users' data? Does the export include deleted/draft/private content? Revision history that was supposed to be pruned?
- **Import/restore as injection**: Can import overwrite existing data? Can it create records that bypass normal validation? Can it inject content into collections the user has no write access to? Does it respect the same permission model as the UI?
- **Search/filter/sort as oracle**: Can search queries reveal whether content exists that the user cannot directly access? Do filter parameters let users probe statuses, roles, or fields they should not know about? Does sorting by a hidden field reveal its values through result ordering?
- **Enumeration through side effects**: Do error messages differ between "does not exist" and "no access"? Do response times differ? Response sizes? HTTP status codes? Can you enumerate users through password reset, invite, or registration flows?
- **Preview/draft/staging leakage**: Are preview tokens scoped to one item or do they unlock broader access? Can draft content be discovered through search, RSS feeds, sitemaps, or API listing endpoints? Can cache headers cause a CDN to serve private content publicly?
- **Notification/webhook as SSRF**: Can a user set a notification URL, webhook URL, or callback URL that the server fetches? Is it validated against internal networks? What about after a redirect?

**Chained vulnerabilities and trust boundaries** (subagent_type: `general`)
Individually allowed or contained behavior can become a vulnerability when another component or lifecycle step relies on a stronger guarantee:
- **Multi-step boundary failures**: Map what a low-privilege principal may read, write, invoke, and retain, then connect only concrete outputs to later trust decisions. Confirm each prerequisite and do not assume a downstream effect.
- **Cross-component trust gaps**: Component A validates input and passes it to component B. Compare the exact guarantee A produces with what B assumes, including truncation, type coercion, normalization, tenant scope, and plugin/extension access.
- **Second-order use**: Data safe when stored may become dangerous in a later context. A field name becomes a JSON path, a slug becomes a file path, escaped text enters raw rendering, or a stored string becomes a URL, regex, template, or policy expression.
- **Scope and capability growth**: Token, API-key, plugin, OAuth, MCP, or AI capabilities become broader after delegation, refresh, caching, role change, or composition. Name the concrete operation the resulting principal should not have.
- **Timing and ordering**: Review setup, migration, soft-delete, revoke/cache expiry, check/use, and validate/consume windows. Confirm stale state is accepted before reporting.
- **Rollback and recovery**: Undelete, restore, revision rollback, and cancellation must apply current ownership, validation, and authorization. Confirm which invalid state is restored.

**Wildcard** (subagent_type: `general`)
You are not given a category. Find vulnerabilities outside the standard classes already assigned.

Read code that looks boring or disconnected from security. Follow incomplete, experimental, compatibility, and fallback features, but retain the same concrete boundary and validation requirements as every other class.

Use these starting points, but do not limit yourself to them:
- What is the strangest code in the codebase? Why does it exist? What happens if it is abused?
- Are there any features that feel half-finished, experimental, or bolted on? Those have the weakest security because they got the least review.
- What happens if you use the API in a way the frontend never would? The UI constrains users, but the API does not. What API calls are possible but never made by the client?
- Are there any hidden or undocumented endpoints, parameters, headers, or features? Look at route registrations, middleware, and config for things that are not in the docs.
- What happens when you mix features that were not designed to work together? Localization + preview + caching. Import + plugins + webhooks. OAuth + impersonation + API keys.
- Is there anything interesting in the git history? Reverted security fixes, commented-out auth checks, secrets that were committed then removed (still in history).
- Which valid-account actions affect other users, shared integrity, availability, or operator-owned cost? Verify containment, quotas, authorization, and recovery around those actions.
- Which operations are irreversible or require elevated confirmation? Bind authorization and approval to the final principal, action, and resource.
- What assumptions does the code make about the environment? That the database is local, that the clock is accurate, that DNS is trustworthy, that the filesystem is case-sensitive?
- Look at the test files — what are they **not** testing? Compare the edge cases the developer thought about (tests exist) with the ones they did not (no tests).

Pursue anomalies inside your assigned scope until the invariant is settled. If something looks strange, read it until you can state whether it is safe. If a function has a comment explaining why it is safe, verify the explanation. If a variable is named `temp` or `hack` or `legacy`, read it closely.

**Obvious things** (subagent_type: `general`)
Other agents hunt subtle bugs. This agent checks the basic exposures that are easy to overlook because everyone assumes someone else already checked them:
- Are there any hardcoded passwords, API keys, tokens, or secrets in the source? (grep for `password`, `secret`, `apikey`, `token`, `Bearer`, `-----BEGIN`, common default passwords)
- Are there any TODO/FIXME/HACK/XXX comments that reference security? (`TODO: add auth`, `FIXME: validate input`, `HACK: skip permission check`)
- Is debug mode / dev mode properly gated? Can it be enabled in production via environment variable, query parameter, or header?
- Are there test/example/seed credentials that work in production?
- Is there a `/debug`, `/admin`, `/test`, `/status`, `/health`, `/metrics`, `/env`, `/.env`, `/config` endpoint that is unprotected?
- Are there any `.env`, `.env.local`, `credentials.json`, `*.pem`, `*.key` files checked into the repo?
- Does the `.gitignore` actually cover secrets, uploads, and local config?
- Are dependencies pinned? Are there known CVEs in the dependency tree? (check lockfiles)
- Are there any `eval()`, `exec()`, `child_process`, `Function()`, `vm.runInContext`, `import()` with dynamic input?
- Are CORS headers set to `*` or overly permissive? Is `Access-Control-Allow-Credentials` combined with a wildcard origin?
- Are cookies missing `HttpOnly`, `Secure`, or `SameSite` attributes?
- Are there any open redirects? (parameters named `redirect`, `return`, `next`, `url`, `goto`, `continue` that feed into redirects without validation)
- Is TLS enforced? Are there any HTTP-only endpoints?
- Are error responses in production returning stack traces, internal paths, or SQL errors?

This agent does not need to be creative. It needs to be thorough and literal. Check every item. Report each result.

**Important**: For any finding this agent reports, it must verify the full code path, not just surface appearance. If a cookie is missing `HttpOnly`, check whether the cookie contains security-sensitive data and whether JS needs to read it by design. If an error message contains a field name, check whether the field is ever actually populated with sensitive data. A flag is not a finding — trace the impact before reporting.

# HTTP-Protocol and Authentication Hunting

#### When to use this file

Reach for this file when the target speaks HTTP at a parsing, caching, browser-authentication, or identity boundary: web applications, APIs, reverse proxies, CDNs, gateways, custom HTTP servers, and services implementing sessions, JWT, OAuth/OIDC, SAML, password recovery, MFA, passkeys, API keys, or mTLS. Use this with `ATTACK-CLASSES.md`: access-control review asks whether a principal may perform an operation; this file asks whether the HTTP or identity layer can confuse which principal, request, assurance level, or token the operation belongs to.

Pick classes from Phase 1. Split a large target into request framing and cache policy, browser authentication, federated identity, strong authentication and recovery, service credentials, and session lifecycle. A single server behind an unobserved managed proxy has little source-confirmable smuggling surface; a proxy or custom parser has much more.

## Core discipline (include in every agent prompt for this domain)

```
- Framing and cache findings require two interpretations of the same request, response, or key. Name both components and the exact normalized value on each side.
- For every credential, find the signature or secret verification and every binding required for its role: issuer, audience, origin, RP, client, session, principal, resource, assurance, expiry, and one-time state.
- Host, Forwarded, X-Forwarded-*, Origin, Referer, redirect targets, callback state, and request-derived URLs are trust decisions. Trace each to the affected identity or response.
- A missing header, cookie attribute, MFA prompt, or rate limit is not a finding alone. Require an accepted invalid request, cross-principal impact, assurance downgrade, or credential disclosure.
- Classify `confirmed` only from complete source evidence and bounded local request/token tests. Use `needs_validation` when proxy, IdP, browser, certificate, secret, or deployed configuration is required but not visible.
```

## HTTP framing and cache attack classes (subagent_type: `general`)

**Request framing and desynchronization**
Front end and back end disagree on request length or header normalization. Review multiple `Content-Length` values, `Transfer-Encoding`, HTTP/2 or HTTP/3 downgrade, header-name normalization, forbidden connection headers, and CR/LF conversion. Confirm which bytes one component assigns to a request and which bytes its peer assigns to the next request.

**Web cache poisoning through unkeyed input**
A request value changes cached content or security-relevant headers but is absent from the cache key. Compare cache key construction with every response variant, including forwarded host/scheme, selected cookies, query normalization, language/device headers, and authorization state.

**Cache deception and private-response caching**
Cache routing treats a private dynamic path as a public static asset, or caches a response whose identity and authorization inputs are missing from policy. Compare edge cacheability with application route parsing, suffix/path-parameter normalization, and response cache directives.

**Host and forwarded-header trust**
Untrusted host/proxy metadata determines absolute URLs, tenant routing, callbacks, reset links, cache keys, or the client address used by authorization. Confirm who can supply the header and whether trusted ingress removes client-provided copies.

**Response-header injection**
Untrusted data reaches `Location`, `Set-Cookie`, CSP, or another response header with unsafe control characters or normalization. Verify framework rejection before reporting and require a security-relevant response change.

## Browser-session attack classes (subagent_type: `general`)

**Ordinary CSRF**
A browser sends ambient credentials to a state-changing endpoint that accepts a cross-site request without an effective anti-CSRF token, same-site request binding, or strict Origin/Referer validation. Inventory every cookie-authenticated mutation, including form, JSON-like, multipart, method-override, and legacy routes. SameSite is effective only for the cookie and browser contexts actually used; login CSRF and cross-site subresource requests can have different requirements.

**Session fixation and invalidation**
Session identifiers are not rotated on login, account switch, MFA completion, impersonation, or other privilege changes, or remain valid after logout, password change, revocation, and account disable. Check server sessions, refresh tokens, signed cookies, websocket state, cache copies, and fallback endpoints.

**Cookie scope and transport**
A sensitive cookie has an over-broad `Domain` or `Path`, can cross an insecure transport, or conflicts with a sibling cookie that another component selects differently. Bare missing flags remain hardening notes unless a realistic less-trusted origin, network position, or browser path can gain or replace the credential.

## Federated-identity attack classes (subagent_type: `general`)

First establish role. Authorization-server controls such as redirect allowlisting and code issuance do not belong to a relying-party client. Verification and binding defects belong to the component consuming the artifact.

**JWT verification and claim binding**
Check signature verification, server-pinned algorithm and key source, then `exp`, `nbf`, `aud`, and `iss`. Review `kid`, `jku`, and `x5u` as untrusted key selectors, duplicate/header normalization, and decode-without-verify paths. A valid token for another service is invalid here even when signed by a trusted issuer.

**OAuth/OIDC request and callback binding**
Validate exact `redirect_uri` ownership where the target is the authorization server; session-bound `state`; PKCE and authorization-code binding where applicable; ID-token issuer/audience/signature/nonce; and selected-IdP binding in multi-provider flows. Compare initial callback, retry, mobile/deep-link, and account-link routes.

**SAML signed-object and assertion binding**
Ensure the element whose signature is validated is the element used as identity. Review unsigned/fallback paths, safe XML parser configuration, canonicalization differences, and freshness/binding fields such as validity windows, audience/recipient, request correlation, and replay state.

## MFA, passkey, and account-transition attack classes (subagent_type: `general`)

**MFA enrollment and assurance downgrade**
Enrollment, replacement, disablement, recovery-code generation, trusted-device creation, and fallback login require the intended prior assurance. Check that a valid first factor cannot enroll or replace the second factor without policy-required fresh authentication, and that disabled or stale factors stop authorizing sessions.

**Step-up binding and bypass**
A successful challenge upgrades the wrong session, account, tenant, action, or API request, or an alternate route omits the assurance check. Bind the challenge to principal, current session, assurance target, operation or resource when required, expiry, and one-time completion. Compare UI, API, batch, recovery, and resumed-flow paths.

**WebAuthn and passkey verification**
At registration, bind challenge, RP ID, expected origin, credential, user/userHandle, algorithm, and policy-required user verification to the initiating session. At authentication, verify challenge, RP/origin, credential membership, signature, and intended user presence/verification. Check account-discovery and linking flows for userHandle or credential-to-account confusion. Signature-counter handling is meaningful only when the product treats regressions as a clone signal.

**Account linking and identity collision**
Adding an IdP, passkey, email, phone, device, or external account to an existing account must require a current authenticated session, verified ownership of the new identity, policy-required step-up, and callback state bound to the account that initiated linking. Review unlink/relink and invite-acceptance paths for verified-identifier or tenant collisions.

**Password reset and broader recovery**
Recovery tokens, support/admin recovery, backup codes, device migration, and email or phone change often become the weakest authentication path. Verify token randomness, user/action binding, expiry, one-time state, rate/accounting controls, delivery URL trust, and invalidation of prior tokens and sessions. Different responses that only reveal public account existence are not automatically security findings.

## API-key and mTLS attack classes (subagent_type: `general`)

**API-key scope and resource binding**
A key authenticates to broader tenants, resources, actions, or environments than its server-side record grants, or request parameters override those bindings. Review key lookup, prefix/full-secret verification, type confusion between publishable and secret keys, scope checks, rotation, revocation caches, and bulk endpoints.

**API-key exposure and unsafe transport**
Keys appear in client bundles, URLs, redirects, logs, error paths, build artifacts, or responses accessible to a lower-trust principal. A public identifier called a key is not a secret. Confirm key type and the authority gained by disclosure.

**mTLS peer and application-identity confusion**
A process trusts client-certificate identity headers from any network peer, verifies a chain but maps attacker-influenceable subject text to an account incorrectly, or accepts a certificate for the wrong trust domain, extended usage, audience, or validity policy. Where a trusted proxy terminates mTLS, verify only that proxy can connect, it removes incoming identity headers, and the backend binds the sanitized identity to the request.

**Certificate lifecycle fallback**
Expired, revoked, missing, or renewal-failed certificates cause silent fallback to bearer-only or anonymous operation, or long-lived pooled connections retain authorization after revocation. Missing deployment revocation data makes the result `needs_validation`; an in-repo fail-open branch is source-confirmable.

## Universal moves (apply across the above)

- Walk issue → store → transmit → consume → refresh → revoke for every credential and challenge. Compare normal, error, retry, migration, legacy, and account-switch paths.
- Enumerate every door to the same identity and every route to the same sensitive operation. The effective policy is the weakest parallel path, not the most polished UI.
- Diff parser, proxy, router, cache, and application normalization side by side. For local validation, feed identical bounded request fixtures into each component rather than sending traffic to a live deployment.
- For recovery and linking, draw the account before/after graph. Each edge must name the current principal, proof of the new identity, required assurance, callback/session binding, and revocation effect.

## Validation rules (apply before reporting ANY finding here)

1. Apply a source-visibility gate. Proxy chains, edge cache keys, IdP policy, certificate trust, browser cookie behavior, secrets, and deployed auth modes may be outside the repository. Record a precise `needs_validation` candidate instead of asserting missing infrastructure behavior.
2. For framing and cache findings, name both components and the divergent parse/key. Confirm cross-request, cross-user, or private-response impact with bounded local fixtures.
3. For token, MFA, passkey, account-link, recovery, API-key, and mTLS findings, cite the verification line and missing principal/session/resource/origin/audience/action/assurance binding. Prove the server accepts the invalid transition or credential.
4. For CSRF, name the ambient credential, state-changing route, accepted cross-site request shape, browser cookie policy, and missing effective check. Read-only actions and routes requiring a non-ambient bearer token do not qualify.
5. Verify framework and library defaults. If version or configuration is unknown, use `needs_validation`; do not turn an unverified critical claim into a lower-severity confirmed finding.
6. Return `confirmed` only with a complete source trace and observable unauthorized identity, state, or disclosure. For `needs_validation`, name the missing fact and safe local or owner-observed check that resolves it.

# Client-Side and Browser Hunting

#### When to use this file

Reach for this file when meaningful trust decisions or untrusted rendering happen in a browser: single-page apps, browser extensions, embedded webviews, service workers, offline applications, and code that renders attacker-influenceable content into the DOM, receives cross-window messages, or uses browser storage. These paths include sources the server never sees, such as URL fragments, `window.name`, `postMessage`, and previously cached content.

Use alongside `ATTACK-CLASSES.md`. This file covers browser sources and sinks, origin boundaries, browser persistence, and cross-site state oracles. Use `DESKTOP-MOBILE-AND-LOCAL-IPC.md` for the native side of a webview bridge, and `WEB-PROTOCOL-AND-AUTH.md` for server-side CSRF, sessions, and auth callbacks.

## Core discipline (include in every agent prompt for this domain)

```
- A client-side candidate needs a controllable source and an executing or disclosing sink. Name both and show attacker-influenced data reaching the sink.
- The impact must reach a victim's session, another origin, or shared persistence. Self-injection and disclosure of the attacker's own data are not findings.
- Framework escaping, browser same-origin policy, CSP, COOP/CORP, service-worker scope, and modern noopener defaults are real controls. Verify them before assigning impact.
- Browser storage and caches are shared by origin and may outlive login state. Identify who writes, who reads, and which account, tenant, or worker lifecycle clears each record.
- Use `confirmed` only for complete source evidence plus bounded local browser tests. Use `needs_validation` when renderer, extension permission, deployed header, or browser-policy behavior is required but unavailable.
```

## DOM and object-state attack classes (subagent_type: `general`)

**DOM-based XSS**
Trace `location` fields, `document.referrer`, `window.name`, message data, storage, and browser-controlled document state into `innerHTML`, `outerHTML`, `document.write`, string-evaluating APIs, executable URLs, jQuery HTML APIs, or framework escape hatches. Interpolation escaped by the framework is not a finding.

**DOM clobbering**
Attacker-injected `id` or `name` attributes shadow a global, form property, configuration object, or initialization flag later trusted by code. Require both a markup path that preserves the attribute and a security-relevant use of the clobbered value.

**Prototype pollution and gadget chain**
An attacker-controlled key reaches a recursive write such as deep merge or path assignment and modifies prototype state. Then a reachable gadget consumes the polluted property to change authorization, execution, navigation, or rendering. `JSON.parse`, a shallow copy, or pollution without a gadget is not enough.

## Cross-origin messaging and network attack classes (subagent_type: `general`)

**`postMessage` origin and source trust**
A handler performs a sensitive action with `event.data` without an exact origin allowlist and, where multiple frames share an origin, the expected `event.source`. On the send side, sensitive data sent to `*` reaches an unintended embedder. Weak substring, prefix, suffix, or unanchored-regex origin matching is not an origin check.

**Cross-site WebSocket request use**
A WebSocket upgrade accepts ambient cookies from an untrusted origin without an `Origin` check or channel-specific token, allowing the victim's session to read or mutate data. Confirm both the upgrade behavior and a security-relevant message handler.

**Credentialed CORS trust**
The server reflects or weakly matches `Origin` while allowing credentials and returns sensitive responses. A bare wildcard with credentials is rejected by browsers; report only the actual reflected/allowed origin path and cross-origin data or mutation.

## Service-worker and browser-storage attack classes (subagent_type: `general`)

**Service-worker registration and scope takeover**
Attacker-influenceable content can become the registered worker script, control a path that receives an over-broad `Service-Worker-Allowed` scope, or alter update imports without integrity control. Verify the final script URL, response MIME type, origin, scope, and who controls every imported script. A normal same-origin worker with intended scope is not a defect.

**Service-worker cache and identity confusion**
The worker caches personalized responses without including account, tenant, authorization state, or request mode in its policy, then serves them after account switch or logout. Review fetch-event routing, cache names and keys, navigation fallbacks, cache cleanup, and whether error/offline paths return another user's prior response.

**Browser-storage disclosure and stale authorization**
Tokens, private responses, draft data, or authorization decisions remain in `localStorage`, `sessionStorage`, IndexedDB, Cache Storage, extension storage, or client state and become readable by another account or less-trusted same-origin component. Storage of a token alone is not a finding; require a realistic reader with less authority, or continued use after revocation/logout.

**Cross-context storage and broadcast confusion**
`storage` events, `BroadcastChannel`, shared workers, or origin-wide caches carry identity or commands between tabs without binding them to the current session. Check account switching, private/public windows, tenant changes, and stale tabs that can overwrite newer auth state.

## Cross-site information leak classes (subagent_type: `general`)

**XS-Leaks and cross-origin state oracles**
An attacker page can distinguish protected cross-origin state through resource load/error events, frame or window state, redirect behavior, timing, cache state, or response size while the browser attaches victim credentials. Require one concrete secret-bearing predicate such as whether a private object, role, or account exists. Generic timing variance or public-resource availability is not a finding.

**Window and opener state disclosure**
A cross-origin window's permitted metadata or navigation result reveals protected state, or a retained opener/named-window relationship lets an attacker-controlled page influence a privileged navigation. Check COOP, frame protections, `noopener`, exact origin, and whether the observable state is confidential.

## UI-redress and navigation attack classes (subagent_type: `general`)

**Clickjacking**
A framed, state-changing action lacks effective `frame-ancestors`, `X-Frame-Options`, or equivalent UI isolation. Require the sensitive action and confirm it can complete in the framed state; missing headers on read-only content are hardening notes.

**Client-side navigation confusion**
A client source controls redirect or navigation without scheme and destination policy, including executable `javascript:` or `data:` destinations. Reverse tabnabbing applies only where code explicitly keeps `window.opener`, uses `window.open` without isolation, or supports a browser without implicit `noopener`.

## Universal moves (apply across the above)

- Start from DOM, navigation, worker, message, and storage sinks, then trace backward to browser-only and server-controlled sources. Record the browser policy that should stop the path.
- Test account switch, logout, worker update, offline fallback, and stale-tab state with a local test origin and dummy accounts. Do not use production users, origins, or shared services.
- For XS-Leaks, list only predicates proved by source and local browser behavior. Then identify the response headers or rendering choice that would remove the oracle.

## Validation rules (apply before reporting ANY finding here)

1. Cite the source, sink, browser policy, affected origin/session, and observable mutation or disclosure.
2. For prototype pollution, prove the recursive write and a security-relevant gadget. For DOM clobbering, prove the markup survives and the shadowed value is used.
3. For service workers and storage, prove lifecycle reachability: an attacker-controlled write or cache entry must reach a different account, tenant, or later authorization state.
4. For messaging, CORS, WebSocket, and XS-Leaks, show exact origin/source validation and the protected state or action exposed. Confirm that CSP, COOP/CORP, cookies, and SameSite policy do not already block it.
5. Return `confirmed` findings only with a complete client path and bounded local evidence. Return `needs_validation` with the precise deployed header, extension permission, browser version, or renderer behavior an owner must verify.
