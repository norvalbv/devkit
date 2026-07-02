#!/bin/bash

# Consolidated pre-commit approval script (devkit commit-guard skill).
# Verifies the relevant reviewer markers are present before a commit is allowed.
#
# Reviewer triggers are derived ENTIRELY from guard.config.json — NOTHING here is hardcoded to a
# specific project's directory layout:
#   - source (DRY/commit-guard gate): `scanRoots`
#   - backend reviewers:  `review.backendRoots`  (api-security, backend-performance)
#   - frontend reviewers: `review.frontendRoots` (frontend-security, frontend-performance)
# A lane with no declared roots simply doesn't apply (its reviewers are skipped).

set -e

CONFIG="guard.config.json"

# Read a JSON string-array from guard.config.json as a space-separated pathspec list (empty if the
# file or key is absent). `$1` is a JS expression over the parsed config `c`; `$2` is the field name
# used in the warning. A PRESENT but invalid value (not an array of non-empty strings) warns to
# stderr and yields empty — the caller then falls back to its default for that lane (scanRoots → scan
# all staged files; backend/frontend → skip those reviewers). An empty array is a deliberate "unset"
# and yields empty WITHOUT a warning.
cfg_roots() {
  [ -f "$CONFIG" ] || return 0
  node -e "try{const c=require('./$CONFIG');const v=(c&&typeof c==='object')?$1:undefined;if(v===undefined||v===null){process.stdout.write('')}else if(Array.isArray(v)&&v.every(x=>typeof x==='string'&&x.length>0)){process.stdout.write(v.join(' '))}else{process.stderr.write('⚠️  commit-guard: ignoring invalid $2 in $CONFIG (expected an array of non-empty strings).\n')}}catch{}"
}

# A PRESENT but unparseable guard.config.json must NOT be silently treated as "nothing declared" —
# that would skip the backend/frontend reviewer gates on a broken config. Fail the gate loudly so a
# malformed config is fixed, not silently waved through. (An ABSENT file stays fine — gate scans all.)
if [ -f "$CONFIG" ] && ! node -e "require('./$CONFIG')" 2>/dev/null; then
  echo "❌ commit-guard: $CONFIG is not valid JSON — refusing to run the gate (fix the config)." >&2
  exit 1
fi

SCAN_ROOTS=$(cfg_roots "c.scanRoots" "scanRoots")
BACKEND_ROOTS=$(cfg_roots "c.review&&c.review.backendRoots" "review.backendRoots")
FRONTEND_ROOTS=$(cfg_roots "c.review&&c.review.frontendRoots" "review.frontendRoots")

# First staged file under the given pathspecs (empty = none). Unquoted expansion word-splits the
# space-separated roots into separate pathspecs.
staged() { git diff --cached --name-only -- "$@" | head -1; }

# Source: scanRoots when declared; otherwise ALL staged files (so the DRY gate never silently
# no-ops on a repo that hasn't declared scanRoots).
if [ -n "$SCAN_ROOTS" ]; then HAS_SOURCE=$(staged $SCAN_ROOTS); else HAS_SOURCE=$(staged .); fi
# Backend/frontend ONLY when their roots are declared — an empty pathspec would match everything
# and wrongly trigger those reviewers on every commit.
HAS_BACKEND=""
[ -n "$BACKEND_ROOTS" ] && HAS_BACKEND=$(staged $BACKEND_ROOTS)
HAS_FRONTEND=""
[ -n "$FRONTEND_ROOTS" ] && HAS_FRONTEND=$(staged $FRONTEND_ROOTS)

echo "🔍 Checking reviewer approvals..."
echo ""

MISSING_APPROVALS=()

# DRY/commit-guard review for any source change.
if [ -n "$HAS_SOURCE" ]; then
    if [ ! -f ".claude/.commit-guard-passed" ]; then
        MISSING_APPROVALS+=("commit-guard (DRY principles)")
    fi
fi

# Backend reviewers
if [ -n "$HAS_BACKEND" ]; then
    echo "📦 Backend changes detected"
    if [ ! -f ".claude/.api-security-passed" ]; then
        MISSING_APPROVALS+=("api-security-reviewer")
    fi
    if [ ! -f ".claude/.backend-performance-passed" ]; then
        MISSING_APPROVALS+=("backend-performance-reviewer")
    fi
fi

# Frontend reviewers
if [ -n "$HAS_FRONTEND" ]; then
    echo "🖥️  Frontend changes detected"
    if [ ! -f ".claude/.frontend-security-passed" ]; then
        MISSING_APPROVALS+=("frontend-security-reviewer")
    fi
    if [ ! -f ".claude/.frontend-performance-passed" ]; then
        MISSING_APPROVALS+=("frontend-performance-reviewer")
    fi
fi

echo ""

# Check if all approvals present
if [ ${#MISSING_APPROVALS[@]} -gt 0 ]; then
    echo "❌ Missing reviewer approvals:"
    for reviewer in "${MISSING_APPROVALS[@]}"; do
        echo "   - $reviewer"
    done
    echo ""
    echo "Run the following reviewers in parallel before committing:"
    echo ""

    if [ -n "$HAS_BACKEND" ]; then
        echo "  Backend reviewers:"
        echo "    - api-security-reviewer"
        echo "    - backend-performance-reviewer"
    fi

    if [ -n "$HAS_FRONTEND" ]; then
        echo "  Frontend reviewers:"
        echo "    - frontend-security-reviewer"
        echo "    - frontend-performance-reviewer"
    fi

    echo "  Always:"
    echo "    - commit-guard"

    exit 1
fi

echo "✅ All relevant reviewers have approved!"
echo ""
echo "You can now commit your changes."
