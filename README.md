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

Serve the admin UI over HTTPS. If TLS terminates at a local reverse proxy, set `ADMIN_TRUST_PROXY=loopback` so Express recognizes the HTTPS request. For other proxy networks, set this to the trusted proxy IP or CIDR accepted by Express. Admin HTTP requests are rejected by default. Session cookies are Secure, HttpOnly, and SameSite=Strict. For local HTTP development only, set `ADMIN_COOKIE_SECURE=false`. The login and logout endpoints require a same-origin browser request. The log search API reads log files in chunks and sends only 50 matching lines at a time.
