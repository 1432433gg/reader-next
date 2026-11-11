# Renderer egress isolation (Linux Docker Engine)

Use this override for the production WebView profile. It installs IPv4/IPv6
filter tables only in a dedicated container network namespace. It requires a
Linux Docker Engine and Docker Compose supporting the !reset override tag.
The supplied verifier was run with Compose v5.7.0.

The renderer shares the renderer-net namespace. Only renderer-net has
NET_ADMIN; the renderer drops every capability and uses no-new-privileges.
The firewall helper has no HTTP API. Its health check becomes ready only after
both rule tables are installed. The renderer starts after this check.

## Policy

- Public IPv4 TCP/UDP destinations remain reachable.
- New connections to private, loopback, link-local, CGNAT, multicast,
  documentation, benchmarking and reserved IPv4 ranges are rejected.
- Docker's embedded DNS at 127.0.0.11 is allowed only at the actual TCP/UDP
  ports discovered from Docker's DNAT rules. Startup fails if those ports
  cannot be identified. Other services on that loopback address remain denied.
- New outbound IPv6 connections are denied in this IPv4 deployment preset,
  including IPv4-mapped or translation-path attempts. IPv6-only sources require
  a separately designed and verified IPv6 policy.
- Administrators must add every host public IPv4 address and any additional
  sensitive IPv4 networks to EGRESS_DENY_CIDRS. Include externally mapped/NAT
  addresses that do not appear on a local interface. A public address cannot
  be identified as the host merely from its destination bytes.
- Established replies are allowed, so the Reader container can call
  remote-webview:8050 over the Compose network. No 8050 host port is published.
- EGRESS_ALLOW_TCP is empty by default. An administrator can explicitly allow
  a trusted IPv4-address:port pair. These exceptions precede the deny list.
  Source rules and API parameters cannot change the firewall environment.
  Never grant a whole private subnet as a test exception.

The rule applies to the renderer's native Node POST requests and every browser
connection, including redirects and subresources. Hostname resolution cannot
turn a private IP into an allowed public destination. The Reader service uses
its own network namespace; an administrator can apply a separate egress policy
to its ordinary HTTP traffic according to deployment requirements.

## Enable

Run from the repository root on the Docker host:

~~~sh
export EGRESS_DENY_CIDRS="$(ip -o -4 addr show scope global | awk '{sub(/\/.*/, "", $4); printf "%s/32 ", $4}')"
# Append externally mapped host public IPv4 /32 addresses and additional
# sensitive IPv4 CIDRs to EGRESS_DENY_CIDRS before starting.
export EGRESS_ALLOW_TCP=""
docker compose -f docker/compose.yml -f docker/compose.egress.yml --profile webview config
docker compose -f docker/compose.yml -f docker/compose.egress.yml --profile webview up -d --build
~~~

Set REMOTE_WEBVIEW_URL=http://remote-webview:8050 in docker/.env.docker, as in the
normal deployment instructions. This override requires EGRESS_DENY_CIDRS
explicitly set and fails configuration if it is missing.

The base Compose file alone is the development topology. The two-file command
above is the declared isolated WebView deployment. It adds a small helper image
built from a pinned Alpine digest with iptables and iproute2. No Docker socket,
host network, host PID namespace or host filesystem mount is needed.

The scripts use iptables-restore and ip6tables-restore atomically. A restart
does not append duplicate rules. To change policy or recover after the helper
is recreated, recreate both services together so the renderer joins the current
protected namespace:

~~~sh
docker compose -f docker/compose.yml -f docker/compose.egress.yml --profile webview up -d --build --force-recreate renderer-net remote-webview
~~~

Inspect configuration and the live rules:

~~~sh
docker compose -f docker/compose.yml -f docker/compose.egress.yml --profile webview ps
docker compose -f docker/compose.yml -f docker/compose.egress.yml exec renderer-net iptables-save
docker compose -f docker/compose.yml -f docker/compose.egress.yml exec renderer-net ip6tables-save
docker compose -f docker/compose.yml -f docker/compose.egress.yml exec renderer-net ip route show
~~~

## Controlled verification

First build the candidate Reader binary with the repository's required
low-memory Cargo settings. Then run:

~~~sh
CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 cargo build --locked --jobs 1
EGRESS_VERIFY_OUTPUT=/absolute/path/to/evidence node docker/egress/verify.mjs
~~~

The verifier needs Node 24, Docker CLI/Compose and permission to create test
containers and a bridge. READER_BINARY can point to a separately compiled
candidate binary. It creates unique project/container names, a fresh bridge,
temporary storage, a normal target and a forbidden target serving a fictional
marker. It records commands, rules, requests and results in the output directory.
It removes only its own test resources on exit.

A single normal-target IPv4/port is explicitly allowed for this test. The
forbidden target has a different port and remains denied. The same marker must
be readable through an unprotected control renderer before the protected
direct-URL, 302 and browser-fetch checks can pass. The protected checks also
cover loopback and IPv6 loopback, and the host public address when present.
Forbidden request counters must remain unchanged. A normal dynamic source must
still pass actual Reader search, details, catalog and first chapter.

The verifier confirms that a separate client on the Compose network resolves
remote-webview and receives a health response. This checks the permitted
Reader-to-renderer communication. EGRESS_VERIFY_PUBLIC_URL and
EGRESS_VERIFY_PUBLIC_MARKER optionally add a public-site reachability check;
the controlled normal reading checks do not depend on an external site.

Validation exceptions are created in the verifier's private test project.
Keep EGRESS_ALLOW_TCP empty in production unless a narrowly scoped trusted
service exception is deliberately required. Removing the override changes the
declared isolation boundary; repeat verification after policy or topology changes.
