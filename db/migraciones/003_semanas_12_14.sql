-- =====================================================================
-- CRM Andino Perú — PROYECTO FINAL · Migración 003 (Semanas 12 a 14)
-- Lo que necesitan las funciones nuevas además del modelo de la Semana 11:
--   · ubicación del lead (ruta del día y check-in)
--   · productos que pide el cliente en el Portal
--   · bandeja de notificaciones de las tres apps
--   · etiqueta de cancelación y costo de adquisición (CRM analítica)
--   · modelos de ML entrenados (coeficientes y métricas)
-- Se puede volver a ejecutar sin errores.
-- =====================================================================
BEGIN;

-- Ubicación del lead / cliente potencial (para el mapa y el check-in a 300 m)
ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS direccion  VARCHAR(200),
    ADD COLUMN IF NOT EXISTS latitud    NUMERIC(9,6) CHECK (latitud BETWEEN -90 AND 90),
    ADD COLUMN IF NOT EXISTS longitud   NUMERIC(9,6) CHECK (longitud BETWEEN -180 AND 180);

-- Productos que el cliente pidió al solicitar la cotización desde el Portal (RF-P03)
CREATE TABLE IF NOT EXISTS solicitud_productos (
    lead_id      INT NOT NULL REFERENCES leads(id),
    producto_id  INT NOT NULL REFERENCES productos(id),
    cantidad     INT NOT NULL CHECK (cantidad > 0),
    PRIMARY KEY (lead_id, producto_id)
);

-- Bandeja de notificaciones. La API crea una por evento; las apps las descargan al
-- sincronizar y las muestran como notificación del sistema (RF-P09, RF-S03).
CREATE TABLE IF NOT EXISTS notificaciones (
    id          BIGSERIAL    PRIMARY KEY,
    usuario_id  INT          NOT NULL REFERENCES usuarios(id),
    tipo        VARCHAR(30)  NOT NULL,
    titulo      VARCHAR(120) NOT NULL,
    cuerpo      VARCHAR(300) NOT NULL,
    ref_tipo    VARCHAR(20),
    ref_id      INT,
    leida       BOOLEAN      NOT NULL DEFAULT FALSE,
    creado_en   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario ON notificaciones(usuario_id, creado_en);

-- CRM analítica: cuándo dejó de comprar un cliente (etiqueta del modelo de churn) y cuánto costó captarlo
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS cancelado_en       DATE,
    ADD COLUMN IF NOT EXISTS costo_adquisicion  NUMERIC(10,2) NOT NULL DEFAULT 1200;

-- Modelos de ML entrenados: la API guarda aquí los coeficientes y las métricas
CREATE TABLE IF NOT EXISTS modelos_ml (
    nombre        VARCHAR(20)  PRIMARY KEY CHECK (nombre IN ('LEAD_SCORING', 'CHURN', 'RFM', 'APRIORI')),
    algoritmo     VARCHAR(60)  NOT NULL,
    version       INT          NOT NULL DEFAULT 1,
    parametros    JSONB        NOT NULL,
    metricas      JSONB        NOT NULL,
    filas         INT          NOT NULL,
    entrenado_en  TIMESTAMPTZ  NOT NULL DEFAULT now()
);


-- Foto del problema adjunta a una solicitud de servicio (RF-P07). Se guarda en la base
-- para que funcione igual en la laptop y en un servidor sin disco (Render).
CREATE TABLE IF NOT EXISTS fotos_solicitud (
    solicitud_id  INT          PRIMARY KEY REFERENCES solicitudes_servicio(id),
    tipo_mime     VARCHAR(30)  NOT NULL CHECK (tipo_mime IN ('image/jpeg', 'image/png', 'image/webp')),
    datos         BYTEA        NOT NULL CHECK (octet_length(datos) <= 5 * 1024 * 1024),
    subida_en     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Meta de ventas del mes (para el pronóstico de la App Supervisor)
CREATE TABLE IF NOT EXISTS metas_ventas (
    mes    CHAR(7)       PRIMARY KEY CHECK (mes ~ '^[0-9]{4}-[0-9]{2}$'),
    monto  NUMERIC(12,2) NOT NULL CHECK (monto > 0)
);

-- Coordenadas de los leads de prueba del parcial alrededor de Huancayo (ficticias)
UPDATE leads SET latitud  = round((-12.0700 + ((id * 37) % 100) / 2500.0)::NUMERIC, 6),
                 longitud = round((-75.2200 + ((id * 53) % 100) / 2500.0)::NUMERIC, 6),
                 direccion = 'Av. Real ' || (100 + id * 7) || ', Huancayo'
 WHERE latitud IS NULL;

-- ---------------------------------------------------------------------
-- Variables de los modelos de ML (Semana 14). Para un lead cerrado se miden
-- en el momento del cierre; para uno abierto, hoy. Así el modelo no "hace trampa".
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_ml_leads AS
WITH cierre AS (
    SELECT DISTINCT ON (h.lead_id) h.lead_id, h.valor_anterior, h.fecha
    FROM historial_lead h
    WHERE h.campo = 'ETAPA' AND h.valor_nuevo IN ('GANADO', 'PERDIDO')
    ORDER BY h.lead_id, h.fecha DESC
), base AS (
    SELECT l.id, l.etapa, l.canal_origen, l.valor_potencial, l.creado_en, l.vendedor_id,
           CASE WHEN l.etapa IN ('GANADO', 'PERDIDO') THEN COALESCE(c.valor_anterior, 'CALIFICADO') ELSE l.etapa END AS etapa_feat,
           CASE WHEN l.etapa IN ('GANADO', 'PERDIDO') THEN COALESCE(c.fecha, l.actualizado_en) ELSE now() END AS fecha_ref,
           CASE l.etapa WHEN 'GANADO' THEN 1 WHEN 'PERDIDO' THEN 0 END AS etiqueta
    FROM leads l LEFT JOIN cierre c ON c.lead_id = l.id
    WHERE l.eliminado = FALSE
)
SELECT b.id, b.etapa, b.etiqueta, b.vendedor_id, b.valor_potencial::float8 AS valor_potencial,
       array_position(ARRAY['NUEVO','CONTACTADO','CALIFICADO','COTIZADO'], b.etapa_feat) - 1 AS etapa_idx,
       (b.canal_origen = 'PORTAL')::int AS canal_portal,
       (b.canal_origen = 'CAMPANA')::int AS canal_campana,
       (SELECT count(*) FROM interacciones i WHERE i.lead_id = b.id AND NOT i.eliminado AND i.fecha_hora <= b.fecha_ref)::int AS n_interacciones,
       (SELECT count(*) FROM visitas v WHERE v.lead_id = b.id AND v.checkin_en IS NOT NULL AND v.checkin_en <= b.fecha_ref)::int AS n_visitas,
       GREATEST(0, EXTRACT(EPOCH FROM b.fecha_ref - COALESCE(
           (SELECT max(i.fecha_hora) FROM interacciones i WHERE i.lead_id = b.id AND NOT i.eliminado AND i.fecha_hora <= b.fecha_ref),
           b.creado_en)) / 86400)::float8 AS dias_sin_contacto
FROM base b;

CREATE OR REPLACE VIEW v_ml_clientes AS
WITH ref AS (
    SELECT c.id, c.cancelado_en, c.fecha_alta,
           COALESCE(c.cancelado_en - 90, CURRENT_DATE)::timestamptz AS fecha_ref
    FROM clientes c
), compras AS (
    SELECT l.cliente_id, co.respondida_en AS fecha, co.total
    FROM cotizaciones co JOIN leads l ON l.id = co.lead_id
    WHERE co.estado = 'ACEPTADA' AND l.cliente_id IS NOT NULL
)
SELECT r.id, (r.cancelado_en IS NOT NULL)::int AS etiqueta,
       COALESCE(EXTRACT(EPOCH FROM r.fecha_ref - (SELECT max(fecha) FROM compras p WHERE p.cliente_id = r.id AND p.fecha <= r.fecha_ref)) / 86400, 365)::float8 AS dias_ultima_compra,
       (SELECT count(*) FROM compras p WHERE p.cliente_id = r.id AND p.fecha <= r.fecha_ref AND p.fecha > r.fecha_ref - interval '365 days')::int AS compras_12m,
       ((SELECT count(*) FROM compras p WHERE p.cliente_id = r.id AND p.fecha <= r.fecha_ref AND p.fecha > r.fecha_ref - interval '180 days')
        - (SELECT count(*) FROM compras p WHERE p.cliente_id = r.id AND p.fecha <= r.fecha_ref - interval '180 days' AND p.fecha > r.fecha_ref - interval '360 days'))::int AS tendencia,
       (SELECT count(*) FROM solicitudes_servicio s WHERE s.cliente_id = r.id AND s.creado_en <= r.fecha_ref AND s.creado_en > r.fecha_ref - interval '180 days')::int AS tickets_180d,
       COALESCE((SELECT avg(calificacion) FROM solicitudes_servicio s WHERE s.cliente_id = r.id AND s.calificacion IS NOT NULL AND s.creado_en <= r.fecha_ref), 4)::float8 AS csat,
       (SELECT count(*) FROM compras p WHERE p.cliente_id = r.id)::int AS compras_total,
       COALESCE((SELECT sum(total) FROM compras p WHERE p.cliente_id = r.id), 0)::float8 AS monto_total,
       (CURRENT_DATE - r.fecha_alta)::int AS dias_antiguedad
FROM ref r;

COMMIT;
