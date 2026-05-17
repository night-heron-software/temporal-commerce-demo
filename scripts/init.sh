#!/usr/bin/env bash
set -euo pipefail

npm run infra:start
npm run db:init

echo ""
echo "✨ Init complete! Next steps:"
echo "   1. npm run start:all   (starts storefront + workers)"
echo "   2. npm run seed        (populates demo data)"
echo ""
echo "Quick start (after init):"
echo "   npm run start:all"
echo "   # In another terminal:"
echo "   npm run seed"
