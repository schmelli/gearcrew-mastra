'use client';

import Link from 'next/link';

const QUICK_ACTIONS = [
  {
    label: 'Enrich Sparse Brands',
    message: 'Find 5 brands with low completeness and enrich them with descriptions, websites, and country info.',
  },
  {
    label: 'Fill Weight Gaps',
    message: 'Find GearItems missing weight_grams and research their weights.',
  },
  {
    label: 'Add Missing Prices',
    message: 'Find GearItems missing price_usd and research current retail prices.',
  },
  {
    label: 'Find Missing Images',
    message: 'Find GearItems missing imageUrl and discover product images for them.',
  },
  {
    label: 'Quality Report',
    message: 'Give me a quality report on the graph. What areas need the most improvement?',
  },
];

export default function QuickActions() {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-sm font-semibold text-gray-900 mb-4">Quick Actions</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {QUICK_ACTIONS.map(({ label, message }) => (
          <Link
            key={label}
            href={`/chat?message=${encodeURIComponent(message)}`}
            className="px-3 py-2 text-sm text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors text-left"
          >
            {label}
          </Link>
        ))}
      </div>
    </div>
  );
}
