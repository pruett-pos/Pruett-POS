-- "Pruett" and "COST" are the same plan (sell at cost). Keep one level named Pruett.
UPDATE price_levels SET kind = 'cost_plus', pct = 0 WHERE name = 'Pruett';
UPDATE customers SET price_level_id = (SELECT id FROM price_levels WHERE name = 'Pruett')
  WHERE price_level_id = (SELECT id FROM price_levels WHERE name = 'COST');
DELETE FROM price_levels WHERE name = 'COST';
