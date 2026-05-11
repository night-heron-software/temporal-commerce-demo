'use client';

import { useMemo, useCallback, useEffect } from 'react';

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
// Printify uses inconsistent type names across blank suppliers:
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
  matchingVariantId?: string;
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
  'NB', '0-3M', '3-6M', '6-9M', '9-12M', '12mo', '12-18M', '18mo', '18-24M', '24mo',
  '2T', '3T', '4T', '5T',
  // Standard
  'XXS', 'XS', 'Small', 'S', 'Medium', 'M', 'Large', 'L', 'XL',
  '1X', '2XL', 'XXL', '2X', '3XL', 'XXXL', '3X', '4XL', '4X', '5XL', '5X', '6XL', '6X',
  // Universal
  'One Size', 'OS',
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
  onVariantChange
}: VariantSelectorProps) {
  // All variants including current one
  const allVariants = useMemo(() => {
    const currentVariant: RelatedVariant = {
      id: currentVariantId,
      blankSku: '', // Not needed for selection logic
      price: { amount: 0, currency: 'USD' },
      available: true,
      options: currentOptions
    };
    // Add current variant if not already in related
    const hasCurrentInRelated = relatedVariants.some((v) => v.id === currentVariantId);
    return hasCurrentInRelated ? relatedVariants : [currentVariant, ...relatedVariants];
  }, [currentVariantId, currentOptions, relatedVariants]);

  // Get current option selections as a map
  const currentSelections = useMemo(() => {
    const map = new Map<string, string>();
    currentOptions.forEach((opt) => {
      map.set(getOptionType(opt), getOptionLabel(opt));
    });
    return map;
  }, [currentOptions]);

  // Extract all option groups with availability
  const optionGroups = useMemo(() => {
    const groups = new Map<
      string,
      Map<string, { hex?: string; variantIds: Array<{ id: string; available: boolean }> }>
    >();

    // Collect all option values from all variants
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
          typeGroup.set(label, { hex: hex || undefined, variantIds: [] });
        }

        typeGroup.get(label)!.variantIds.push({
          id: variant.id,
          available: variant.available
        });
      });
    });

    // Helper function to find matching variant (defined locally to avoid hook order issues)
    const findMatchingVariant = (
      changeType: string,
      changeValue: string
    ): RelatedVariant | undefined => {
      const newSelections = new Map(currentSelections);
      newSelections.set(changeType, changeValue);

      return allVariants.find((variant) => {
        const variantOptions = new Map<string, string>();
        variant.options?.forEach((opt) => {
          variantOptions.set(getOptionType(opt), getOptionLabel(opt));
        });

        for (const [type, label] of newSelections) {
          if (variantOptions.get(type) !== label) {
            return false;
          }
        }
        return true;
      });
    };

    // Convert to array format
    const result: OptionGroup[] = [];
    groups.forEach((values, type) => {
      const optionValues: OptionValue[] = [];
      values.forEach((info, label) => {
        // An option value is available if ANY variant with that option is available
        // AND matches current selections for OTHER option types
        const matchingVariant = findMatchingVariant(type, label);
        const available = matchingVariant ? matchingVariant.available : false;

        optionValues.push({
          label,
          hex: info.hex,
          available,
          matchingVariantId: matchingVariant?.id
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
  }, [allVariants, currentSelections]);

  // Find a variant that matches current selections except for one option type
  const findMatchingVariantForOption = useCallback(
    (changeType: string, changeValue: string): RelatedVariant | undefined => {
      // Create new selections with the changed value
      const newSelections = new Map(currentSelections);
      newSelections.set(changeType, changeValue);

      // Find a variant that matches all selections
      return allVariants.find((variant) => {
        const variantOptions = new Map<string, string>();
        variant.options?.forEach((opt) => {
          variantOptions.set(getOptionType(opt), getOptionLabel(opt));
        });

        // Check if all selections match
        for (const [type, label] of newSelections) {
          if (variantOptions.get(type) !== label) {
            return false;
          }
        }
        return true;
      });
    },
    [allVariants, currentSelections]
  );

  // Handle option selection - call onVariantChange callback
  const handleOptionSelect = useCallback(
    (type: string, label: string) => {
      const matchingVariant = findMatchingVariantForOption(type, label);
      if (matchingVariant && matchingVariant.id !== currentVariantId) {
        if (onVariantChange) {
          onVariantChange(matchingVariant);
        }
      }
    },
    [findMatchingVariantForOption, currentVariantId, onVariantChange]
  );

  // Auto-select single available options
  useEffect(() => {
    optionGroups.forEach((group) => {
      const availableValues = group.values.filter((v) => v.available);
      if (availableValues.length === 1) {
        const singleValue = availableValues[0];
        const currentSelection = currentSelections.get(group.type);

        // Only select if not already selected
        if (currentSelection !== singleValue.label) {
          handleOptionSelect(group.type, singleValue.label);
        }
      }
    });
  }, [optionGroups, currentSelections, handleOptionSelect]);

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
                <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{value.label}</span>
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
            <label className="block text-sm font-medium text-zinc-500 mb-3">{group.displayLabel}</label>
            <div className="flex flex-wrap gap-2">
              {group.values.map((value) => {
                const isSelected = currentSelections.get(group.type) === value.label;
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
                            : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-600 cursor-not-allowed line-through'
                      }
                      ${showSwatch ? 'pl-9' : ''}
                    `}
                    title={!value.available ? 'Unavailable' : value.label}
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
                    {!value.available && <span className="sr-only">(Unavailable)</span>}
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
