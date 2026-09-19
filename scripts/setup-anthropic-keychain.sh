#!/bin/sh
set -eu

service="${TURNTURN_ANTHROPIC_KEYCHAIN_SERVICE:-com.turnturn.anthropic-api-key}"
account="${TURNTURN_ANTHROPIC_KEYCHAIN_ACCOUNT:-${USER:?USER is required}}"

printf 'Store the Anthropic API key in macOS Keychain for account %s.\n' "$account"
printf 'macOS will prompt for the key; it is not read by this script.\n'
exec /usr/bin/security add-generic-password -a "$account" -s "$service" -U -w
