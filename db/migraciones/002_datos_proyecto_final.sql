-- =====================================================================
-- CRM Andino Perú — PROYECTO FINAL · DATOS DE PRUEBA para las tablas nuevas (ficticios)
-- Ejecutar DESPUÉS de 001_proyecto_final.sql, sobre la base del parcial con seed.sql.
-- Cuentas nuevas (contraseñas guardadas como hash bcrypt):
--   Agentes : sofia@crmandino.pe (senior), marco@crmandino.pe  / agente123
--   Cliente : rosa@ferreteriaeltambo.pe (Portal)                 / cliente123
-- Datos ficticios: los RUC tienen formato válido pero no corresponden a empresas reales.
-- =====================================================================
BEGIN;

-- Territorios de los vendedores del parcial
UPDATE usuarios SET territorio = 'Huancayo'  WHERE correo = 'carlos@crmandino.pe';
UPDATE usuarios SET territorio = 'El Tambo'  WHERE correo = 'lucia@crmandino.pe';
UPDATE usuarios SET territorio = 'Chilca'    WHERE correo = 'diego@crmandino.pe';
UPDATE usuarios SET territorio = 'Concepción' WHERE correo = 'valeria@crmandino.pe';

-- Agentes de servicio
INSERT INTO usuarios (nombre, correo, clave_hash, rol, es_senior) VALUES
  ('Sofía Rojas Meza',   'sofia@crmandino.pe', '$2a$10$gtbZTs8v4jnwLzl7KAkotO6DJAqZ2l9qWvzN3iYKuxcoh70YKk9bC', 'agente', TRUE),
  ('Marco Poma Alarcón', 'marco@crmandino.pe', '$2a$10$gtbZTs8v4jnwLzl7KAkotO6DJAqZ2l9qWvzN3iYKuxcoh70YKk9bC', 'agente', FALSE)
ON CONFLICT (correo) DO NOTHING;

-- Catálogo
INSERT INTO productos (codigo, nombre, categoria, precio, margen_pct) VALUES
  ('FAC-01', 'Facturación electrónica (licencia por usuario)', 'LICENCIA',      1900.00, 62),
  ('INV-01', 'Módulo Inventario',                              'MODULO',        3200.00, 58),
  ('PLA-01', 'Módulo Planillas',                               'MODULO',        2800.00, 55),
  ('CRM-01', 'CRM para pymes (licencia por usuario)',          'LICENCIA',      1500.00, 60),
  ('SOP-01', 'Soporte anual prioritario',                      'SERVICIO',      2400.00, 70),
  ('IMP-01', 'Implementación y migración de datos',            'SERVICIO',      4500.00, 35),
  ('CAP-01', 'Capacitación (grupo de 10 personas)',            'CAPACITACION',  1990.00, 45)
ON CONFLICT (codigo) DO NOTHING;

-- Una cuenta de cliente por cada lead GANADO del parcial (RN-05), con RUC ficticio y puntajes simulados
INSERT INTO clientes (ruc, razon_social, distrito, vendedor_id, puntaje_valor, prob_cancelacion, cltv, fecha_alta)
SELECT '20' || lpad((600000000 + l.id * 7919)::TEXT, 9, '0'),
       l.empresa, u.territorio, l.vendedor_id,
       40 + (l.id * 37) % 60,                      -- 40..99
       round(((l.id * 13) % 80) / 100.0, 3),       -- 0.00..0.79
       8000 + (l.id * 911) % 20000,
       CURRENT_DATE - ((l.id * 53) % 900)
FROM leads l JOIN usuarios u ON u.id = l.vendedor_id
WHERE l.etapa = 'GANADO'
ON CONFLICT (ruc) DO NOTHING;

UPDATE leads l SET cliente_id = c.id
FROM clientes c WHERE c.razon_social = l.empresa AND l.etapa = 'GANADO' AND l.cliente_id IS NULL;

-- Cliente del Portal (el de la ficha del caso)
INSERT INTO clientes (ruc, razon_social, direccion, distrito, latitud, longitud, vendedor_id, puntaje_valor, prob_cancelacion, cltv)
SELECT '20612345671', 'Ferretería El Tambo SAC', 'Av. Mariscal Castilla 1450', 'El Tambo', -12.0569, -75.2153,
       (SELECT id FROM usuarios WHERE correo = 'carlos@crmandino.pe'), 84, 0.120, 41000
ON CONFLICT (ruc) DO NOTHING;

INSERT INTO usuarios (nombre, correo, clave_hash, rol, cliente_id, telefono, consentimiento_en)
SELECT 'Rosa Quispe', 'rosa@ferreteriaeltambo.pe', '$2a$10$co3qBTsyprHJEt8PhramO.fCbw0dm.tljNJY3pYmqSH5U1o8oKY1.',
       'cliente', c.id, '964123456', now()
FROM clientes c WHERE c.ruc = '20612345671'
ON CONFLICT (correo) DO NOTHING;

-- Canal de origen y puntaje (ML-01 simulado) para los leads abiertos del parcial
UPDATE leads SET puntaje = 15 + (id * 29) % 80,
                 telefono = '9' || lpad(((id * 7331) % 100000000)::TEXT, 8, '0')
WHERE puntaje IS NULL;

-- Recomendaciones de venta cruzada (ML-04 simulado)
INSERT INTO recomendaciones (cliente_id, producto_id, confianza, lift, razon)
SELECT c.id, p.id, 0.52, 1.8, 'Clientes que compraron Facturación también compraron Inventario'
FROM clientes c, productos p WHERE c.ruc = '20612345671' AND p.codigo = 'INV-01'
ON CONFLICT DO NOTHING;

COMMIT;
