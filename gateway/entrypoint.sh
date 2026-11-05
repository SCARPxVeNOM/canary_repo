#!/bin/sh
# First start: create the config and KPS identity key, then set the address the
# gateway advertises (ADVERTISE, comma-separated IPs). Later starts reuse both.
set -eu
CFG="$HOME/.config/tor-js-gateway/config.json5"
if [ ! -f "$CFG" ]; then
  tor-js-gateway init
fi
if [ -n "${KPS_PORT:-}" ]; then
  # The port is part of the published address, so it must match the one clients dial.
  sed -i "s|\"kps_port\": *[0-9]*|\"kps_port\": $KPS_PORT|" "$CFG"
fi
if [ -n "${ADVERTISE:-}" ]; then
  list=$(printf '%s' "$ADVERTISE" | sed 's/[^,][^,]*/"&"/g')
  sed -i "s|\"advertised_addresses\": *\[[^]]*\]|\"advertised_addresses\": [$list]|" "$CFG"
fi
exec tor-js-gateway -c "$CFG"
