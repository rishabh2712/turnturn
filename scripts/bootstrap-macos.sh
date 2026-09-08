#!/usr/bin/env bash
set -euo pipefail

missing=0
toolchain_bin="$HOME/.local/turnturn-toolchain/node-current/bin"

if [ -d "$toolchain_bin" ]; then
  export PATH="$toolchain_bin:$PATH"
fi

check() {
  local name="$1"
  local command="$2"

  if command -v "$command" >/dev/null 2>&1; then
    printf "ok: %s\n" "$name"
  else
    printf "missing: %s\n" "$name"
    missing=1
  fi
}

printf "Checking local development prerequisites...\n"

if xcode-select -p >/dev/null 2>&1; then
  printf "ok: Apple Command Line Tools\n"
else
  printf "missing: Apple Command Line Tools\n"
  printf "install: xcode-select --install\n"
  missing=1
fi

if command -v brew >/dev/null 2>&1; then
  printf "ok: Homebrew\n"
else
  printf "optional: Homebrew not found\n"
fi
check "git" git
check "Node.js" node
check "pnpm" pnpm
check "ripgrep" rg

if [ "$missing" -ne 0 ]; then
  printf "\nInstall missing tools, then run this script again.\n"
  exit 1
fi

printf "\nAll prerequisites are available.\n"
