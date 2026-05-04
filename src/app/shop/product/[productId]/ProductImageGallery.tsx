'use client';

import { useState } from 'react';
import Image from 'next/image';

interface ProductImageGalleryProps {
  images: Record<string, string>;
  productName: string;
}

export default function ProductImageGallery({ images, productName }: ProductImageGalleryProps) {
  const imageEntries = Object.entries(images).sort(([a], [b]) => {
    // Order: front first, back second, then alphabetical
    const order = ['front', 'back'];
    const aIdx = order.indexOf(a.toLowerCase());
    const bIdx = order.indexOf(b.toLowerCase());
    if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
    if (aIdx >= 0) return -1;
    if (bIdx >= 0) return 1;
    return a.localeCompare(b);
  });

  // Default to the first image in the sorted list, or empty if none
  const [selectedImage, setSelectedImage] = useState<string | null>(
    imageEntries.length > 0 ? imageEntries[0][1] : null
  );

  const [selectedLabel, setSelectedLabel] = useState<string | null>(
    imageEntries.length > 0 ? imageEntries[0][0] : null
  );

  if (imageEntries.length === 0) {
    return (
      <div className="aspect-square bg-zinc-200 dark:bg-zinc-800 rounded-xl flex items-center justify-center text-zinc-500">
        No images available
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Main Image */}
      <div className="relative aspect-square bg-zinc-100 dark:bg-zinc-900 rounded-xl overflow-hidden border border-zinc-200 dark:border-zinc-800">
        {selectedImage ? (
          <Image
            src={selectedImage}
            alt={`${productName} - ${selectedLabel}`}
            fill
            className="object-contain"
            sizes="(max-width: 768px) 100vw, 50vw"
            unoptimized
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-zinc-400">
            No image selected
          </div>
        )}
        {selectedLabel && (
          <span className="absolute bottom-3 left-3 px-3 py-1 bg-black/60 text-white text-xs rounded-full capitalize backdrop-blur-sm">
            {selectedLabel}
          </span>
        )}
      </div>

      {/* Thumbnails */}
      {imageEntries.length > 1 && (
        <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide">
          {imageEntries.map(([label, url]) => (
            <button
              key={label}
              onClick={() => {
                setSelectedImage(url);
                setSelectedLabel(label);
              }}
              className={`relative flex-shrink-0 w-20 h-20 rounded-lg overflow-hidden border-2 transition-all ${
                selectedLabel === label
                  ? 'border-purple-500 ring-2 ring-purple-500/20'
                  : 'border-transparent hover:border-zinc-300 dark:hover:border-zinc-700'
              }`}
            >
              <Image src={url} alt={label} fill className="object-cover" sizes="80px" unoptimized />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
