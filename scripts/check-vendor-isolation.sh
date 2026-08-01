#!/usr/bin/env bash
#
# CLAUDE.md rule 1: no vendor name outside src/lib/drivers/, src/lib/publish/, or
# src/lib/storage/.
#
# storage/ joined the exclusion list when the object store moved behind a StorageDriver
# interface: the vendor name belongs in the implementation, not in the module path, and
# the implementation has to be allowed to say it somewhere.
#
# The rule has teeth because the alternative is a codebase where swapping the video
# model is a refactor instead of a config change (ARCHITECTURE.md §0.1). Models rotate
# quarterly; the loop is the durable asset.
#
# If this fails, the fix is almost never "move the string somewhere else". It is that
# the driver interface is missing something the caller needed. Fix the interface.

set -uo pipefail

VENDORS='higgsfield\|elevenlabs'
status=0

# ── Check 1: the rule exactly as written in CLAUDE.md ────────────────────────
# Reproduced verbatim so that what CI enforces and what the spec says cannot drift.
hits=$(grep -rl "$VENDORS" src --exclude-dir=drivers --exclude-dir=publish --exclude-dir=storage 2>/dev/null)

if [[ -n "$hits" ]]; then
  echo "FAIL: vendor names found outside the driver, publish and storage layers:"
  echo
  while IFS= read -r file; do
    echo "  $file"
    grep -n "$VENDORS" "$file" | sed 's/^/      /'
  done <<<"$hits"
  echo
  status=1
fi

# ── Check 2: the same rule, case-insensitively ───────────────────────────────
# The literal command above is case-sensitive, so HIGGSFIELD_API_KEY in a config file
# would slip through a rule it plainly violates. This closes that gap. Reported
# separately because it is stricter than the letter of the spec.
ci_hits=$(grep -rli "$VENDORS" src --exclude-dir=drivers --exclude-dir=publish --exclude-dir=storage 2>/dev/null)

if [[ -n "$ci_hits" ]]; then
  new_hits=$(comm -13 <(echo "$hits" | sort -u) <(echo "$ci_hits" | sort -u) | grep -v '^$' || true)
  if [[ -n "$new_hits" ]]; then
    echo "FAIL: vendor names found outside the driver layer (case-insensitive):"
    echo
    while IFS= read -r file; do
      echo "  $file"
      grep -ni "$VENDORS" "$file" | sed 's/^/      /'
    done <<<"$new_hits"
    echo
    echo "  Vendor credentials belong in src/lib/drivers/env.ts, not in core config."
    echo
    status=1
  fi
fi

if [[ $status -eq 0 ]]; then
  echo "OK: no vendor names outside src/lib/drivers/, src/lib/publish/ and src/lib/storage/."
fi

exit $status
