#!/usr/bin/env bash
set -euo pipefail

ACE_MCP_VERSION="${ACE_MCP_VERSION:-4.9.11}"
ACE_MCP_MIN_NODE_VERSION="${ACE_MCP_MIN_NODE_VERSION:-18.18.0}"
ACE_MCP_RELEASE_BASE_URL="${ACE_MCP_RELEASE_BASE_URL:-https://gitee.com/AndrewFengCode/ace-mcp/releases/download/v${ACE_MCP_VERSION}}"
ACE_MCP_TGZ_URL="${ACE_MCP_TGZ_URL:-${ACE_MCP_RELEASE_BASE_URL}/ace-mcp-${ACE_MCP_VERSION}.tgz}"
ACE_MCP_TMP_DIR="${TMPDIR:-/tmp}/ace-mcp-install-${ACE_MCP_VERSION}-$$"

log() {
  printf '[ace-mcp] %s\n' "$*"
}

fail() {
  printf '[ace-mcp] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  rm -rf "$ACE_MCP_TMP_DIR"
}

trap cleanup EXIT

require_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    fail "This installer is for macOS. Use npm install -g ace-mcp on other platforms."
  fi
}

require_command() {
  local command_name="$1"
  local install_hint="$2"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    fail "Missing ${command_name}. ${install_hint}"
  fi
}

version_ge() {
  local current="${1#v}"
  local required="$2"
  local current_major=0 current_minor=0 current_patch=0
  local required_major=0 required_minor=0 required_patch=0

  IFS=. read -r current_major current_minor current_patch <<<"$current"
  IFS=. read -r required_major required_minor required_patch <<<"$required"

  current_major="${current_major:-0}"
  current_minor="${current_minor:-0}"
  current_patch="${current_patch:-0}"
  required_major="${required_major:-0}"
  required_minor="${required_minor:-0}"
  required_patch="${required_patch:-0}"

  if (( current_major > required_major )); then return 0; fi
  if (( current_major < required_major )); then return 1; fi
  if (( current_minor > required_minor )); then return 0; fi
  if (( current_minor < required_minor )); then return 1; fi
  (( current_patch >= required_patch ))
}

node_version_ok() {
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    return 1
  fi

  local node_version
  node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  [[ -n "$node_version" ]] && version_ge "$node_version" "$ACE_MCP_MIN_NODE_VERSION"
}

ensure_node() {
  if node_version_ok; then
    log "Node.js $(node --version) and npm $(npm --version) detected."
    return
  fi

  if command -v brew >/dev/null 2>&1; then
    log "Node.js >=${ACE_MCP_MIN_NODE_VERSION} not found. Installing node@22 with Homebrew..."
    brew install node@22
    export PATH="/opt/homebrew/opt/node@22/bin:/usr/local/opt/node@22/bin:$PATH"
    if ! node_version_ok; then
      brew link node@22 --force --overwrite >/dev/null 2>&1 || true
    fi
  fi

  if ! node_version_ok; then
    fail "Need Node.js >=${ACE_MCP_MIN_NODE_VERSION} and npm. Install Homebrew from https://brew.sh, then run: brew install node@22"
  fi

  log "Node.js $(node --version) and npm $(npm --version) are ready."
}

install_package() {
  mkdir -p "$ACE_MCP_TMP_DIR"
  local tgz_path="${ACE_MCP_TMP_DIR}/ace-mcp-${ACE_MCP_VERSION}.tgz"

  log "Downloading ${ACE_MCP_TGZ_URL}"
  curl -fL "$ACE_MCP_TGZ_URL" -o "$tgz_path"

  log "Installing ace-mcp ${ACE_MCP_VERSION} globally..."
  if npm install -g "$tgz_path"; then
    return
  fi

  if command -v xcode-select >/dev/null 2>&1 && ! xcode-select -p >/dev/null 2>&1; then
    fail "npm install failed and Xcode Command Line Tools are not installed. Run xcode-select --install, finish the prompt, then rerun this installer."
  fi

  fail "npm install failed. Check the npm error above, then rerun this installer."
}

verify_install() {
  log "Verifying ace-mcp..."
  ace-mcp --version
  ace-mcp --doctor
  log "Install complete. Start the Web panel with: ace-mcp-web"
}

main() {
  require_macos
  require_command "curl" "curl is bundled with macOS; install Command Line Tools if it is missing."
  ensure_node
  install_package
  verify_install
}

main "$@"
