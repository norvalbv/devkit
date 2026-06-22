#!/bin/bash

# Consolidated pre-commit approval script
# Checks that all relevant reviewers have approved before allowing commit
#
# Reviewers are invoked based on which files are staged:
# - Backend files (src/main/, vercel-serverless/, socket-server/): api-security, backend-performance
# - Frontend files (src/renderer/, src/preload/): frontend-security, frontend-performance
# - DRY review: always runs for src/, vercel-serverless/, and socket-server/

set -e

# Check what's staged
HAS_BACKEND=$(git diff --cached --name-only -- src/main/ vercel-serverless/ socket-server/ | head -1)
HAS_FRONTEND=$(git diff --cached --name-only -- src/renderer/ src/preload/ | grep -v '\.pen$' | head -1)
# Any source change (incl. src/shared) — the DRY/commit-guard gate is codebase-wide, not just
# backend/frontend (a src/shared-only commit must still require the commit-guard marker).
HAS_SOURCE=$(git diff --cached --name-only -- src/ vercel-serverless/ socket-server/ | grep -v '\.pen$' | head -1)

echo "🔍 Checking reviewer approvals..."
echo ""

MISSING_APPROVALS=()

# Always check DRY/pre-commit review for any src/, vercel-serverless/, or socket-server/ changes
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
