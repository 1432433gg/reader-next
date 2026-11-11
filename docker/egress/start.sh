#!/bin/sh
set -eu
rm -f /run/egress-ready
: "${EGRESS_DENY_CIDRS:?Configure every host public/NAT IPv4 as /32}"
EGRESS_ALLOW_TCP=${EGRESS_ALLOW_TCP:-}

# Resolve Docker DNS's actual post-DNAT ports, rather than allowing every
# service that could be bound to the resolver's loopback address.
dns_port() {
    protocol=$1
    value=$(iptables -t nat -S | awk -v protocol="$protocol" '
        /--dport 53/ && /--to-destination 127\.0\.0\.11:/ {
            found = 0
            for (i = 1; i <= NF; i++) {
                if ($i == "-p" && $(i + 1) == protocol) found = 1
                if ($i == "--to-destination") {
                    split($(i + 1), address, ":")
                    port = address[2]
                }
            }
            if (found) print port
        }')
    case "$value" in ''|*[!0-9]*) echo "Docker embedded DNS port unavailable" >&2; exit 1 ;; esac
    test "$value" -gt 0 && test "$value" -le 65535
    echo "$value"
}
dns_tcp=$(dns_port tcp)
dns_udp=$(dns_port udp)

# Atomically replace only this network namespace's filter tables.
rules=$(mktemp)
trap 'rm -f "$rules"' EXIT
{
    echo '*filter'
    echo ':INPUT ACCEPT [0:0]'
    echo ':FORWARD DROP [0:0]'
    echo ':OUTPUT DROP [0:0]'
    echo ':READER_EGRESS - [0:0]'
    echo '-A OUTPUT -j READER_EGRESS'
    echo '-A READER_EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT'
    echo "-A READER_EGRESS -d 127.0.0.11/32 -p udp --dport $dns_udp -j ACCEPT"
    echo "-A READER_EGRESS -d 127.0.0.11/32 -p tcp --dport $dns_tcp -j ACCEPT"
    for entry in $EGRESS_ALLOW_TCP; do
        address=$(echo "$entry" | cut -d: -f1)
        port=$(echo "$entry" | cut -d: -f2)
        case "$address:$port" in *[!0-9.:]*) echo "Invalid TCP exception" >&2; exit 1 ;; esac
        echo "-A READER_EGRESS -d $address/32 -p tcp --dport $port -j ACCEPT"
    done
    for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 \
        169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 \
        192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 \
        224.0.0.0/4 240.0.0.0/4 $EGRESS_DENY_CIDRS; do
        echo "-A READER_EGRESS -d $cidr -j REJECT"
    done
    echo '-A READER_EGRESS -j ACCEPT'
    echo COMMIT
} > "$rules"
iptables-restore < "$rules"
# This preset supports public IPv4 sites. New IPv6 connections are denied.
{
    echo '*filter'
    echo ':INPUT ACCEPT [0:0]'
    echo ':FORWARD DROP [0:0]'
    echo ':OUTPUT DROP [0:0]'
    echo '-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT'
    echo COMMIT
} > "$rules"
ip6tables-restore < "$rules"
rm -f "$rules"
trap - EXIT
touch /run/egress-ready
exec sleep infinity
