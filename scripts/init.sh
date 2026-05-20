#!/usr/bin/env bash
set -euo pipefail

npm run infra:up
npm run db:init

echo ""
echo "✨ Init complete! Next steps:"
echo "   1. npm run dev:up      (starts storefront + workers)"
echo "   2. npm run dev:seed     (populates demo data)"
echo ""
echo "Quick start (after init):"
echo "   npm run dev:up"
echo "   # In another terminal:"
echo "   npm run dev:seed"
