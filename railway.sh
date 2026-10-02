#!/usr/bin/env bash
# Deploy to Railway. Run it again any time to push updates.
#
# First run: opens a browser to sign in, creates the project, deploys it,
# and gives it a public https://*.up.railway.app address.
set -euo pipefail

cd "$(dirname "$0")"

if command -v railway >/dev/null 2>&1; then
	railway() { command railway "$@"; }
else
	railway() { npx -y @railway/cli "$@"; }
fi

if railway status >/dev/null 2>&1; then
	echo "==> Deploying update"
	railway up --ci
	echo
	railway domain list
else
	echo "==> First deploy: sign in, create the project, and deploy"
	railway up --yes --ci --name browser-ios
	echo
	echo "==> Creating the public address"
	railway domain
fi

echo
echo "On the iPhone: open the https://... address above in Safari,"
echo "then Share -> Add to Home Screen. The first load can take a minute"
echo "while Railway finishes starting the app."
