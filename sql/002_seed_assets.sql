-- Activos base. El motor de matching solo admite idActivo en [0, 4].
INSERT INTO assets (id, symbol, name) VALUES
  (0, 'ECO',  'Ecopetrol'),
  (1, 'PFB',  'Bancolombia Preferencial'),
  (2, 'ISA',  'Interconexion Electrica'),
  (3, 'GEB',  'Grupo Energia Bogota'),
  (4, 'CLH',  'Cemex Latam Holdings')
ON CONFLICT (id) DO NOTHING;
