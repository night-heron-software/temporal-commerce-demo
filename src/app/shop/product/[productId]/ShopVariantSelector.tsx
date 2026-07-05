'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';

interface CassandraOption {
  option_type?: string;
  optionType?: string;
  label?: string;
  attributes?: Record<string, string>;
  value?: { label?: string; name?: string; hex?: string };
}

interface RelatedVariant {
  id: string;
  blankSku: string;
  price: { amount: number; currency: string };
  available: boolean;
  variantImageUrl?: string;
  options?: CassandraOption[];
}

interface VariantSelectorProps {
  currentVariantId: string;
  currentOptions: CassandraOption[];
  relatedVariants: RelatedVariant[];
  productId?: string;
  onVariantChange?: (variant: RelatedVariant) => void;
}

// Helper to get option type from either format
function getOptionType(option: CassandraOption): string {
  return option.optionType || option.option_type || 'Option';
}

// Helper to get option label
function getOptionLabel(option: CassandraOption): string {
  // Cassandra flat: option.label; ES indexed: option.value.label
  return option.label || option.value?.label || option.value?.name || '';
}

// Helper to get hex color from attributes
function getOptionHex(option: CassandraOption): string | null {
  // Cassandra flat: option.attributes.hex; ES indexed: option.value.hex
  if (option.attributes?.hex) {
    return option.attributes.hex;
  }
  if (option.value?.hex) {
    return option.value.hex;
  }
  return null;
}

// ─── Semantic option type detection ──────────────────────────────────────────
// Option type names can be inconsistent across fulfillers:
//   Colors: "Colors", "Bella + Canvas Colors", "AS Color colors", "Comfort Colors® Colors"
//   Sizes:  "Sizes", "Clothing sizes"
function isColorType(type: string): boolean {
  const lower = type.toLowerCase();
  return lower.includes('color');
}

function isSizeType(type: string): boolean {
  const lower = type.toLowerCase();
  return lower.includes('size');
}

// Canonical display label for grouped option types
function getDisplayLabel(type: string): string {
  if (isColorType(type)) return 'Color';
  if (isSizeType(type)) return 'Size';
  return type;
}

// Sort priority: Color first, then Size, then anything else
function getGroupSortOrder(type: string): number {
  if (isColorType(type)) return 0;
  if (isSizeType(type)) return 1;
  return 2;
}

// Represents an option value with availability info
interface OptionValue {
  label: string;
  hex?: string;
  available: boolean;
}

// Represents an option type with all its possible values
interface OptionGroup {
  type: string;
  displayLabel: string;
  isColor: boolean;
  values: OptionValue[];
}

// ─── Size sort order ─────────────────────────────────────────────────────────
const SIZE_ORDER = [
  // Infant/Toddler
  'NB',
  '0-3M',
  '3-6M',
  '6-9M',
  '9-12M',
  '12mo',
  '12-18M',
  '18mo',
  '18-24M',
  '24mo',
  '2T',
  '3T',
  '4T',
  '5T',
  // Standard
  'XXS',
  'XS',
  'Small',
  'S',
  'Medium',
  'M',
  'Large',
  'L',
  'XL',
  '1X',
  '2XL',
  'XXL',
  '2X',
  '3XL',
  'XXXL',
  '3X',
  '4XL',
  '4X',
  '5XL',
  '5X',
  '6XL',
  '6X',
  // Universal
  'One Size',
  'OS',
];

function sortSizes(values: OptionValue[]): void {
  values.sort((a, b) => {
    let aIdx = SIZE_ORDER.indexOf(a.label);
    let bIdx = SIZE_ORDER.indexOf(b.label);

    // Case-insensitive fallback
    if (aIdx === -1) aIdx = SIZE_ORDER.findIndex((s) => s.toLowerCase() === a.label.toLowerCase());
    if (bIdx === -1) bIdx = SIZE_ORDER.findIndex((s) => s.toLowerCase() === b.label.toLowerCase());

    if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
    if (aIdx >= 0) return -1;
    if (bIdx >= 0) return 1;

    // Numeric fallback (e.g. 11oz vs 15oz)
    const aNum = parseFloat(a.label);
    const bNum = parseFloat(b.label);
    if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;

    return a.label.localeCompare(b.label, undefined, { numeric: true });
  });
}

function sortColors(values: OptionValue[]): void {
  values.sort((a, b) => a.label.localeCompare(b.label));
}

export default function ShopVariantSelector({
  currentVariantId,
  currentOptions,
  relatedVariants,
  onVariantChange,
}: VariantSelectorProps) {
  // All variants with options — only those with options can participate in selection
  const allVariants = useMemo(() => {
    const currentVariant: RelatedVariant = {
      id: currentVariantId,
      blankSku: '',
      price: { amount: 0, currency: 'USD' },
      available: true,
      options: currentOptions,
    };
    const hasCurrentInRelated = relatedVariants.some((v) => v.id === currentVariantId);
    const combined = hasCurrentInRelated ? relatedVariants : [currentVariant, ...relatedVariants];
    return combined.filter((v) => v.options && v.options.length > 0);
  }, [currentVariantId, currentOptions, relatedVariants]);

  // ── Decoupled selection state ──
  // Selections are tracked independently from the current variant.
  // Changing size never auto-changes color, and vice versa.
  const [selections, setSelections] = useState<Map<string, string>>(() => {
    const map = new Map<string, string>();
    currentOptions.forEach((opt) => {
      map.set(getOptionType(opt), getOptionLabel(opt));
    });
    return map;
  });

  // Sync selections when parent changes the variant externally (e.g., initial load).
  // Use a flag to distinguish external changes from our own onVariantChange calls.
  const prevVariantId = useRef(currentVariantId);
  const isInternalChange = useRef(false);
  useEffect(() => {
    if (currentVariantId !== prevVariantId.current) {
      prevVariantId.current = currentVariantId;
      // Only sync if this was an external change (not from our own selection)
      if (!isInternalChange.current) {
        const map = new Map<string, string>();
        currentOptions.forEach((opt) => {
          map.set(getOptionType(opt), getOptionLabel(opt));
        });
        setSelections(map);
      }
      isInternalChange.current = false;
    }
  }, [currentVariantId, currentOptions]);

  // Collect all option groups — availability is contextual to current selections.
  // When Size=L is selected, only colors that have a variant with Size=L show as available.
  // When nothing is selected, all globally-available values show as available.
  const optionGroups = useMemo(() => {
    const groups = new Map<string, Map<string, { hex?: string }>>();

    // First pass: collect all option values and their hex codes
    allVariants.forEach((variant) => {
      variant.options?.forEach((opt) => {
        const type = getOptionType(opt);
        const label = getOptionLabel(opt);
        const hex = getOptionHex(opt);

        if (!groups.has(type)) {
          groups.set(type, new Map());
        }

        const typeGroup = groups.get(type)!;
        if (!typeGroup.has(label)) {
          typeGroup.set(label, { hex: hex || undefined });
        }
      });
    });

    // Second pass: compute contextual availability
    // For each option value, check if any available variant has it AND matches
    // all OTHER currently-selected options.
    const result: OptionGroup[] = [];
    groups.forEach((values, type) => {
      const optionValues: OptionValue[] = [];
      values.forEach((info, label) => {
        const available = allVariants.some((variant) => {
          if (!variant.available) return false;
          // Must have this option value
          const hasValue = variant.options?.some(
            (opt) => getOptionType(opt) === type && getOptionLabel(opt) === label,
          );
          if (!hasValue) return false;
          // Must also match all OTHER selected options
          for (const [selType, selLabel] of selections) {
            if (selType === type) continue; // skip the option type we're checking
            const variantHasOther = variant.options?.some(
              (opt) => getOptionType(opt) === selType && getOptionLabel(opt) === selLabel,
            );
            if (!variantHasOther) return false;
          }
          return true;
        });

        optionValues.push({
          label,
          hex: info.hex,
          available,
        });
      });

      // Sort values based on semantic type
      if (isSizeType(type)) {
        sortSizes(optionValues);
      } else if (isColorType(type)) {
        sortColors(optionValues);
      }

      result.push({
        type,
        displayLabel: getDisplayLabel(type),
        isColor: isColorType(type),
        values: optionValues,
      });
    });

    // Sort groups: Color → Size → other
    result.sort((a, b) => getGroupSortOrder(a.type) - getGroupSortOrder(b.type));

    return result;
  }, [allVariants, selections]);

  // Find the best matching variant for current selections
  const findBestVariant = useCallback(
    (targetSelections: Map<string, string>): RelatedVariant | undefined => {
      // 1. Try exact match first
      const exact = allVariants.find((variant) => {
        const variantOpts = new Map<string, string>();
        variant.options?.forEach((opt) => {
          variantOpts.set(getOptionType(opt), getOptionLabel(opt));
        });
        for (const [type, label] of targetSelections) {
          if (variantOpts.get(type) !== label) return false;
        }
        return true;
      });
      if (exact) return exact;

      // 2. No exact match — find variant with highest overlap score
      let bestVariant: RelatedVariant | undefined;
      let bestScore = -1;

      for (const variant of allVariants) {
        if (!variant.available) continue;
        const variantOpts = new Map<string, string>();
        variant.options?.forEach((opt) => {
          variantOpts.set(getOptionType(opt), getOptionLabel(opt));
        });

        let score = 0;
        for (const [type, label] of targetSelections) {
          if (variantOpts.get(type) === label) score++;
        }

        if (score > bestScore) {
          bestScore = score;
          bestVariant = variant;
        }
      }

      return bestVariant;
    },
    [allVariants],
  );

  // Handle option click — toggle: re-clicking a selected option deselects it
  const handleOptionSelect = useCallback((type: string, label: string) => {
    setSelections((prev) => {
      const next = new Map(prev);
      if (prev.get(type) === label) {
        // Toggle off — deselect this option
        next.delete(type);
      } else {
        next.set(type, label);
      }
      return next;
    });
  }, []);

  // When selections change, find and report the best matching variant.
  // Only update the parent when all option types are selected (partial = browsing).
  const optionTypeCount = optionGroups.length;
  useEffect(() => {
    if (selections.size < optionTypeCount) return; // partial selection = browsing
    const bestVariant = findBestVariant(selections);
    if (bestVariant && bestVariant.id !== currentVariantId && onVariantChange) {
      isInternalChange.current = true;
      onVariantChange(bestVariant);
    }
  }, [selections, optionTypeCount, findBestVariant, currentVariantId, onVariantChange]);

  // ─── Determine display mode ───────────────────────────────────────────────
  // No option groups at all → render nothing
  if (optionGroups.length === 0) {
    return null;
  }

  // Every group has exactly one value → show as static info, no interactive selector
  const isSingleOption = optionGroups.every((g) => g.values.length <= 1);

  if (isSingleOption) {
    return (
      <div className="bg-white dark:bg-zinc-950 p-6 rounded-xl border border-zinc-200 dark:border-zinc-800">
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          {optionGroups.map((group) => {
            const value = group.values[0];
            if (!value) return null;
            return (
              <div key={group.type} className="flex items-center gap-2">
                <span className="text-sm font-medium text-zinc-500">{group.displayLabel}:</span>
                {group.isColor && value.hex && (
                  <span
                    className="inline-block w-4 h-4 rounded-full border border-zinc-300 dark:border-zinc-600"
                    style={{ backgroundColor: value.hex }}
                  />
                )}
                <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {value.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-zinc-950 p-6 rounded-xl border border-zinc-200 dark:border-zinc-800">
      <h3 className="text-lg font-semibold mb-4">Select Options</h3>
      <div className="space-y-6">
        {optionGroups.map((group) => (
          <div key={group.type}>
            <label className="block text-sm font-medium text-zinc-500 mb-3">
              {group.displayLabel}
            </label>
            <div className="flex flex-wrap gap-2">
              {group.values.map((value) => {
                const isSelected = selections.get(group.type) === value.label;
                const showSwatch = group.isColor && value.hex;

                return (
                  <button
                    key={value.label}
                    onClick={() => value.available && handleOptionSelect(group.type, value.label)}
                    disabled={!value.available}
                    className={`
                      relative px-4 py-2 rounded-lg text-sm font-medium transition-all
                      ${
                        isSelected
                          ? 'bg-purple-600 text-white ring-2 ring-purple-600 ring-offset-2 dark:ring-offset-zinc-950'
                          : value.available
                            ? 'bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-900 dark:text-zinc-100'
                            : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-600 opacity-40 cursor-not-allowed line-through'
                      }
                      ${showSwatch ? 'pl-9' : ''}
                    `}
                    title={!value.available ? 'Not available with current selection' : value.label}
                  >
                    {showSwatch && value.hex && (
                      <span
                        className={`absolute left-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full border-2 ${
                          isSelected ? 'border-white' : 'border-zinc-300 dark:border-zinc-600'
                        }`}
                        style={{ backgroundColor: value.hex }}
                      />
                    )}
                    {value.label}
                    {!value.available && (
                      <span className="sr-only">(Unavailable with current selection)</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
