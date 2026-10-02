-- Pruett's pricing plan percentages (from AL, Oct 2026). Only fills levels that are still unset,
-- so changes made later in Settings → Price levels are never overwritten.
UPDATE price_levels SET kind = 'discount', pct = 7  WHERE name = 'CONTRACTOR'   AND pct IS NULL;
UPDATE price_levels SET kind = 'discount', pct = 3  WHERE name = 'Contractor 2' AND pct IS NULL;
UPDATE price_levels SET kind = 'discount', pct = 12 WHERE name = 'Builder'      AND pct IS NULL;
UPDATE price_levels SET kind = 'discount', pct = 18 WHERE name = 'Wholesale'    AND pct IS NULL;
