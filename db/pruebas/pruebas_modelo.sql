-- =====================================================================
-- CRM Andino Perú — PRUEBAS DEL MODELO DE DATOS (Semana 11)
-- Recorre los flujos F1 (Portal → venta) y F3 (proceso de lealtad) y comprueba
-- que la base RECHACE lo que las reglas de negocio prohíben.
-- Se ejecuta en una transacción que al final se deshace (ROLLBACK): no deja datos.
--   psql "$DATABASE_URL" -f db/pruebas/pruebas_modelo.sql
-- =====================================================================
\set ON_ERROR_STOP on
\o /dev/null
BEGIN;

-- Helper: ejecuta una sentencia que DEBE fallar y verifica el mensaje.
CREATE OR REPLACE FUNCTION pg_temp.debe_fallar(sentencia TEXT, contiene TEXT, prueba TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE sentencia;
    RAISE EXCEPTION 'FALLÓ LA PRUEBA "%": la base aceptó algo prohibido', prueba;
EXCEPTION WHEN check_violation OR not_null_violation OR foreign_key_violation OR unique_violation THEN
    IF position(lower(contiene) IN lower(SQLERRM)) = 0 THEN
        RAISE EXCEPTION 'FALLÓ LA PRUEBA "%": error inesperado: %', prueba, SQLERRM;
    END IF;
    RAISE NOTICE 'OK  %', prueba;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.ok(condicion BOOLEAN, prueba TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF NOT condicion THEN RAISE EXCEPTION 'FALLÓ LA PRUEBA "%"', prueba; END IF;
    RAISE NOTICE 'OK  %', prueba;
END $$;

SET LOCAL crm.usuario_id = '1';

-- ---------- F1 · Del Portal a la venta ----------
-- 1) El prospecto pide cotización: lead NUEVO, canal PORTAL, con código de seguimiento
INSERT INTO leads (uuid, empresa, contacto, valor_potencial, etapa, vendedor_id, canal_origen, codigo_seguimiento, ruc, puntaje)
VALUES ('11111111-1111-4111-8111-111111111111', 'Ferretería El Tambo SAC', 'Rosa Quispe', 12400, 'NUEVO',
        (SELECT id FROM usuarios WHERE correo = 'carlos@crmandino.pe'), 'PORTAL', siguiente_numero('SOL'), '20612345671', 78);
SELECT pg_temp.ok((SELECT codigo_seguimiento LIKE 'SOL-____-0001' FROM leads WHERE uuid = '11111111-1111-4111-8111-111111111111'),
                  'El lead del Portal recibe código SOL-AAAA-0001');

SELECT pg_temp.debe_fallar($$INSERT INTO leads (uuid, empresa, contacto, etapa, vendedor_id, canal_origen)
    VALUES (gen_random_uuid(), 'X', 'Y', 'NUEVO', 1, 'PORTAL')$$, 'leads_portal_check', 'Lead del Portal sin código de seguimiento');
SELECT pg_temp.debe_fallar($$INSERT INTO leads (uuid, empresa, contacto, etapa, vendedor_id) VALUES (gen_random_uuid(), '  ', 'Y', 'NUEVO', 1)$$,
                           'leads_empresa_check', 'RN-01: lead sin empresa');
SELECT pg_temp.debe_fallar($$UPDATE leads SET canal_origen = 'VENDEDOR' WHERE uuid = '11111111-1111-4111-8111-111111111111'$$,
                           'RN-02', 'RN-02: el canal de origen no se modifica');
SELECT pg_temp.debe_fallar($$UPDATE leads SET etapa = 'PERDIDO' WHERE uuid = '11111111-1111-4111-8111-111111111111'$$,
                           'leads_perdido_check', 'PERDIDO exige motivo');

-- 2) El vendedor lo contacta y lo califica
UPDATE leads SET etapa = 'CONTACTADO' WHERE uuid = '11111111-1111-4111-8111-111111111111';
UPDATE leads SET etapa = 'CALIFICADO' WHERE uuid = '11111111-1111-4111-8111-111111111111';
SELECT pg_temp.debe_fallar($$UPDATE leads SET etapa = 'NUEVO' WHERE uuid = '11111111-1111-4111-8111-111111111111'$$,
                           'Transición no permitida', 'El embudo no retrocede (CALIFICADO → NUEVO)');

-- 3) Arma la cotización: el total sale del detalle
INSERT INTO cotizaciones (uuid, numero, lead_id, vendedor_id, descuento_pct)
SELECT '22222222-2222-4222-8222-222222222222', siguiente_numero('COT'), l.id, l.vendedor_id, 8
FROM leads l WHERE l.uuid = '11111111-1111-4111-8111-111111111111';
INSERT INTO cotizacion_detalle (cotizacion_id, producto_id, cantidad, precio_unit)
SELECT c.id, p.id, x.cant, p.precio
FROM cotizaciones c, productos p
JOIN (VALUES ('FAC-01', 5), ('CAP-01', 2)) x(cod, cant) ON x.cod = p.codigo
WHERE c.uuid = '22222222-2222-4222-8222-222222222222';
SELECT pg_temp.ok((SELECT subtotal = 13480 AND total = 12401.60 FROM cotizaciones WHERE uuid = '22222222-2222-4222-8222-222222222222'),
                  'Total = Σ(precio × cantidad) × (1 − 8 %) = S/ 12,401.60');
SELECT pg_temp.debe_fallar($$UPDATE cotizaciones SET total = 1 WHERE uuid = '22222222-2222-4222-8222-222222222222'$$,
                           'cot_total_check', 'No se puede escribir un total distinto al calculado');

-- 4) Descuento mayor a 10 % sin aprobación: no se puede enviar (RN-03)
UPDATE cotizaciones SET descuento_pct = 15, total = round(subtotal * 0.85, 2) WHERE uuid = '22222222-2222-4222-8222-222222222222';
SELECT pg_temp.debe_fallar($$UPDATE cotizaciones SET estado = 'ENVIADA', enviada_en = now(), vigencia_hasta = CURRENT_DATE + 15
                             WHERE uuid = '22222222-2222-4222-8222-222222222222'$$,
                           'cot_aprobacion_check', 'RN-03: descuento de 15 % sin aprobación del supervisor');
UPDATE cotizaciones SET estado = 'PEND_APROBACION' WHERE uuid = '22222222-2222-4222-8222-222222222222';
UPDATE cotizaciones SET estado = 'ENVIADA', aprobada_por = (SELECT id FROM usuarios WHERE rol = 'supervisor' LIMIT 1),
                        enviada_en = now(), vigencia_hasta = CURRENT_DATE + 15
 WHERE uuid = '22222222-2222-4222-8222-222222222222';
UPDATE leads SET etapa = 'COTIZADO' WHERE uuid = '11111111-1111-4111-8111-111111111111';
SELECT pg_temp.ok(TRUE, 'Con aprobación del supervisor la cotización se envía');

-- 5) RN-04: una cotización vencida no se acepta
SAVEPOINT vencida;
UPDATE cotizaciones SET vigencia_hasta = CURRENT_DATE - 1 WHERE uuid = '22222222-2222-4222-8222-222222222222';
SELECT pg_temp.debe_fallar($$UPDATE cotizaciones SET estado = 'ACEPTADA', respondida_en = now()
                             WHERE uuid = '22222222-2222-4222-8222-222222222222'$$, 'RN-04', 'RN-04: no se acepta una cotización vencida');
ROLLBACK TO SAVEPOINT vencida;

-- 6) Rechazo exige motivo; aceptación vigente pasa el lead a GANADO
SELECT pg_temp.debe_fallar($$UPDATE cotizaciones SET estado = 'RECHAZADA' WHERE uuid = '22222222-2222-4222-8222-222222222222'$$,
                           'cot_rechazo_check', 'Rechazar sin motivo');
UPDATE cotizaciones SET estado = 'ACEPTADA', respondida_en = now() WHERE uuid = '22222222-2222-4222-8222-222222222222';
UPDATE leads SET etapa = 'GANADO', cliente_id = (SELECT id FROM clientes WHERE ruc = '20612345671')
 WHERE uuid = '11111111-1111-4111-8111-111111111111';
SELECT pg_temp.debe_fallar($$UPDATE leads SET etapa = 'PERDIDO', motivo_perdida = 'x' WHERE uuid = '11111111-1111-4111-8111-111111111111'$$,
                           'GANADO', 'Un lead GANADO ya no cambia de etapa');
SELECT pg_temp.ok((SELECT count(*) = 4 FROM historial_lead h JOIN leads l ON l.id = h.lead_id
                   WHERE l.uuid = '11111111-1111-4111-8111-111111111111' AND h.campo = 'ETAPA'),
                  'RNF-09: el historial registró las 4 transiciones de etapa');
SELECT pg_temp.ok((SELECT count(*) = 2 FROM v_compras_cliente WHERE cliente_id = (SELECT id FROM clientes WHERE ruc = '20612345671')),
                  'La compra aparece en el historial del cliente (2 productos)');

-- ---------- F2 · Visita en campo ----------
SELECT pg_temp.debe_fallar($$INSERT INTO visitas (uuid, lead_id, vendedor_id, fecha_programada, checkin_en, latitud, longitud, distancia_m)
    SELECT gen_random_uuid(), id, vendedor_id, CURRENT_DATE, now(), -12.06, -75.21, 450 FROM leads LIMIT 1$$,
                           'visita_300m_check', 'RF-V13: check-in a 450 m sin motivo');
SELECT pg_temp.debe_fallar($$INSERT INTO visitas (uuid, lead_id, vendedor_id, fecha_programada, checkin_en)
    SELECT gen_random_uuid(), id, vendedor_id, CURRENT_DATE, now() FROM leads LIMIT 1$$,
                           'visita_gps_check', 'Check-in sin coordenadas GPS');

-- ---------- F3 · Proceso de lealtad ----------
SELECT pg_temp.debe_fallar($$INSERT INTO solicitudes_servicio (uuid, numero, cliente_id, creada_por, categoria, descripcion, puntaje_cliente, prioridad, sla_hasta)
    SELECT gen_random_uuid(), 'SRV-X', c.id, u.id, 'FACTURACION', 'No se envían las boletas a SUNAT desde ayer', 84, 'NORMAL', now() + interval '4 hours'
    FROM clientes c JOIN usuarios u ON u.cliente_id = c.id WHERE c.ruc = '20612345671'$$,
                           'srv_prioridad_check', 'RN-06: un cliente con puntaje 84 no puede quedar en prioridad NORMAL');
SELECT pg_temp.debe_fallar($$INSERT INTO solicitudes_servicio (uuid, numero, cliente_id, creada_por, categoria, descripcion, puntaje_cliente, prioridad, sla_hasta)
    SELECT gen_random_uuid(), 'SRV-Y', c.id, u.id, 'FACTURACION', 'No funciona', 84, 'ALTA', now() + interval '4 hours'
    FROM clientes c JOIN usuarios u ON u.cliente_id = c.id WHERE c.ruc = '20612345671'$$,
                           'descripcion_check', 'RF-P07: descripción menor a 20 caracteres');

INSERT INTO solicitudes_servicio (uuid, numero, cliente_id, creada_por, categoria, descripcion, puntaje_cliente, prioridad, agente_id, sla_hasta)
SELECT '33333333-3333-4333-8333-333333333333', siguiente_numero('SRV'), c.id, u.id, 'FACTURACION',
       'No se envían las boletas a SUNAT desde ayer', c.puntaje_valor, 'ALTA',
       (SELECT id FROM usuarios WHERE rol = 'agente' AND es_senior LIMIT 1), now() + interval '4 hours'
FROM clientes c JOIN usuarios u ON u.cliente_id = c.id WHERE c.ruc = '20612345671';

SELECT pg_temp.debe_fallar($$UPDATE solicitudes_servicio SET calificacion = 5 WHERE uuid = '33333333-3333-4333-8333-333333333333'$$,
                           'srv_calif_check', 'No se califica un ticket que no está resuelto');
SELECT pg_temp.debe_fallar($$UPDATE solicitudes_servicio SET estado = 'CERRADA' WHERE uuid = '33333333-3333-4333-8333-333333333333'$$,
                           'no permitido', 'Un ticket ABIERTO no salta a CERRADA');
UPDATE solicitudes_servicio SET estado = 'EN_ATENCION' WHERE uuid = '33333333-3333-4333-8333-333333333333';
UPDATE solicitudes_servicio SET estado = 'RESUELTA', resuelta_en = now(), solucion = 'Certificado digital renovado'
 WHERE uuid = '33333333-3333-4333-8333-333333333333';
UPDATE solicitudes_servicio SET calificacion = 5, calificada_en = now() WHERE uuid = '33333333-3333-4333-8333-333333333333';
SELECT pg_temp.debe_fallar($$UPDATE solicitudes_servicio SET calificacion = 3 WHERE uuid = '33333333-3333-4333-8333-333333333333'$$,
                           'RF-P12', 'RF-P12: solo una calificación por ticket');
SELECT pg_temp.ok((SELECT count(*) = 3 FROM eventos_solicitud e JOIN solicitudes_servicio s ON s.id = e.solicitud_id
                   WHERE s.uuid = '33333333-3333-4333-8333-333333333333'),
                  'RNF-09: el ticket guarda su historial (ABIERTA → EN_ATENCION → RESUELTA)');

-- ---------- F4 · Campañas ----------
INSERT INTO campanas (nombre, segmento, oferta, producto_id, descuento_pct, canales, inicio, fin, creada_por)
SELECT 'Inventario -15 %', '{"tieneProducto":"FAC-01","sinProducto":"INV-01"}', 'Módulo Inventario con 15 % de descuento',
       p.id, 15, ARRAY['PUSH', 'WHATSAPP', 'CORREO'], CURRENT_DATE, CURRENT_DATE + 30,
       (SELECT id FROM usuarios WHERE rol = 'supervisor' LIMIT 1)
FROM productos p WHERE p.codigo = 'INV-01';
SELECT pg_temp.debe_fallar($$INSERT INTO campanas (nombre, segmento, oferta, canales, inicio, fin, creada_por)
    VALUES ('X', '{}', 'X', ARRAY['FAX'], CURRENT_DATE, CURRENT_DATE, 1)$$, 'canales_check', 'Canal de campaña inválido');

UPDATE clientes SET acepta_ofertas = FALSE WHERE ruc <> '20612345671';
SELECT pg_temp.debe_fallar($$INSERT INTO respuestas_campana (campana_id, cliente_id, canal)
    SELECT (SELECT max(id) FROM campanas), id, 'PUSH' FROM clientes WHERE ruc <> '20612345671' LIMIT 1$$,
                           'RN-07', 'RN-07: un cliente sin ofertas no recibe campañas');
INSERT INTO respuestas_campana (campana_id, cliente_id, canal, respondio, respondido_en)
SELECT (SELECT max(id) FROM campanas), id, 'PUSH', TRUE, now() FROM clientes WHERE ruc = '20612345671';
SELECT pg_temp.ok((SELECT tasa_respuesta = 100 FROM v_respuestas_por_canal WHERE canal = 'PUSH'),
                  'RF-S08: respuestas por canal calculadas');

SELECT pg_temp.debe_fallar($$INSERT INTO usuarios (nombre, correo, clave_hash, rol) VALUES ('X', 'x@x.pe', 'h', 'cliente')$$,
                           'usuarios_cliente_check', 'Un usuario cliente siempre pertenece a una cuenta');
SELECT pg_temp.debe_fallar($$INSERT INTO clientes (ruc, razon_social) VALUES ('123', 'X')$$,
                           'clientes_ruc_check', 'RF-P01: RUC de 11 dígitos');

\o
\echo
\echo '>>> TODAS LAS PRUEBAS DEL MODELO PASARON'
ROLLBACK;
