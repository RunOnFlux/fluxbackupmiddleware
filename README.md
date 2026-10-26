# FluxDrive Backup Middleware

Stores Flux Dapp images to FluxDrive

## Requirements

Requires node version 16.0 and above, mysql 8.0 and above

## Installation

Install npm dependencies with command:

```javascript
npm install
```

## Usage

Start the service with command:

```javascript
npm start
```

Service will be started on 127.0.0.1:2052

## Admin UI

Open `/admin/` on the service host. Add the wallet addresses allowed to sign in to the ignored `secrets.json` file:

```json
{
  "adminAddresses": ["YOUR_FLUX_ADDRESS", "0xYOUR_ETHEREUM_ADDRESS"]
}
```

Keep the existing secret keys in that file. Restart the service after changing the list. An empty or missing list denies every admin login. Use **Open Zelcore to sign**, or sign the displayed one-time message in another compatible wallet and paste the address and signature. Each challenge lasts five minutes and can be used once. Admin sessions last eight hours and are invalidated at logout or service restart.

The dashboard counts completed backup files and bytes from active task records. Its seven-day chart uses UTC calendar days. New marketplace app tracking begins when this schema update is installed; older apps have no known first-seen date.

Serve the admin UI over HTTPS. TLS may terminate at a load balancer that forwards HTTP to this service; no proxy trust setting is needed. Session cookies are Secure, HttpOnly, and SameSite=Strict. Login, logout, and wallet session redemption require an HTTPS same-origin browser request. For local HTTP development only, set `ADMIN_COOKIE_SECURE=false`. The log search API reads log files in chunks and sends only 50 matching lines at a time.


## Outbound backup authentication

Manual backup transfers use the requesting app owner's `zelidauth`; the middleware never substitutes a team login for a missing or expired owner session. Re-register a manual task with fresh authentication if its session expires. Only HTTP(S) backup URLs without embedded credentials or fragments are accepted. Authenticated downloads can follow same-origin redirects only. Node login, backup operations, and cleanup do not follow redirects.

The middleware uses the same node URL conversion as flux-frontend: `http://185.209.30.228:16127` becomes `https://185-209-30-228-16127.node.api.runonflux.io`. No per-node allowlist or configuration is needed. Authenticated requests verify TLS certificates and never fall back to plaintext. HTTP is accepted only on loopback for local test fixtures or a local TLS tunnel.

Node operators are trusted recipients under this deployment's trust model. A receiving operator can still read and replay the global team login; HTTPS does not make that login node-scoped. Removing this protocol limitation requires scoped authorization in FluxOS. Strict challenge validation and redirect controls remain enforced.

## Registry confirmation

Owners, full specifications, expiry decisions, block heights, and backup source locations are confirmed using independent FluxOS backends, rather than trusting one `api.runonflux.io` answer. Backend discovery comes from the API gateway's own HTTPS HAProxy statistics, which are served outside the FluxOS backends. Queries go directly to three distinct backend IPs through their HTTPS node URLs, without credentials or redirects. Matching specifications require two votes; a location must be present in two answers. Duplicate backend IPs never count twice.

Only confirmed answers are cached. Owner/specification caches last one minute; destructive expiry checks request fresh confirmation. Missing, malformed, divergent, or unavailable answers fail closed and do not authorize an owner or confirm app deletion. This protects against a single faulty or malicious backend; it is not a substitute for consensus validation against colluding backends or a compromised gateway.

## Transfer and queue limits

Downloads reject an oversized Content-Length before creating the partial file and enforce the declared size on every streamed chunk, including chunked responses. A mismatch or timeout removes partial files and releases the disk reservation. `backupDownloadTimeoutMs` defaults to two hours and cancels the socket even when data keeps arriving.

Running tasks retain their concurrency slot until their work settles; they are never evicted just because they are old. Queue order uses server-controlled `startTime` and `taskId`, placing retries behind never-started tasks. `maxConcurrentTasksPerOwner` defaults to two, within the existing global task limit. Duplicate registrations share a single runner, and pending manual tasks can refresh their owner credentials without starting a duplicate.

The API allows 600 requests per minute per socket peer, with separate limits of 30 logins and 60 backup mutations per minute. Limits return HTTP 429 and Retry-After. Forwarded headers do not change the rate-limit identity, so callers behind the same proxy share an IP budget. Authenticated owners may submit 60 backup registrations per ten minutes; new manual tasks also enforce `maxPendingTasksPerOwner` (100) and `maxPendingManualTasks` (1000). Internal automatic backup registration is exempt from these submission limits, while sharing concurrency controls.

FDM statistics are read as CSV. Only UP servers in an exact `appname_port.app.runonflux.io` backend (or the app2 equivalent) qualify; substring matches and rows belonging to other apps are ignored. Active-server fallback stays within one backend, and every selected node still requires independent location confirmation.
