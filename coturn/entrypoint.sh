#!/bin/sh
set -eu
set -- -c /etc/coturn/turnserver.conf --realm="${TURN_HOST:?TURN_HOST required}"
# Match the application's precedence: shared secret, then static credentials.
if [ -n "${TURN_SECRET:-}" ]; then
 set -- "$@" --use-auth-secret --static-auth-secret="$TURN_SECRET"
else
 set -- "$@" --lt-cred-mech --user="${TURN_USERNAME:?TURN_USERNAME required when TURN_SECRET is unset}:${TURN_PASSWORD:?TURN_PASSWORD required when TURN_SECRET is unset}"
fi
if [ -n "${EXTERNAL_IP:-}" ]; then set -- "$@" --external-ip="$EXTERNAL_IP"; fi
if [ -n "${TLS_CERT:-}" ] && [ -n "${TLS_KEY:-}" ]; then
 set -- "$@" --cert="$TLS_CERT" --pkey="$TLS_KEY"
else
 set -- "$@" --no-tls --no-dtls
fi
exec turnserver "$@"
