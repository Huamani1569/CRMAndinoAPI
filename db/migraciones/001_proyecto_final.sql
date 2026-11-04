-- =====================================================================
-- CRM Andino Perú — PROYECTO FINAL · Semana 11 · MODELO DE DATOS AMPLIADO
-- Migración 001: parte del esquema del parcial (db/schema.sql, Semana 8)
-- y lo amplía para las tres apps: Vendedor, Portal del Cliente y Supervisor.
--
--   psql "$DATABASE_URL" -f db/migraciones/001_proyecto_final.sql
--
-- Todo se ejecuta en UNA transacción: si algo falla, la base queda como estaba.
-- Se puede volver a ejecutar sin errores (idempotente).
-- Las tablas del parcial se conservan (con sus datos); solo se agregan columnas,
-- se amplían los valores permitidos y se crean las tablas nuevas.
-- Base: Laudon y Laudon, cap. 9 (CRM operacional y analítico).
-- =====================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- 0. Utilidades
-- ---------------------------------------------------------------------

-- Correlativos legibles por año: COT-2026-0142, SRV-2026-0388, SOL-2026-0412.
CREATE TABLE IF NOT EXISTS correlativos (
    prefijo  VARCHAR(5) NOT NULL,
    anio     INT        NOT NULL,
    ultimo   INT        NOT NULL DEFAULT 0,
    PRIMARY KEY (prefijo, anio)
);

CREATE OR REPLACE FUNCTION siguiente_numero(p_prefijo TEXT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
    v_anio INT := EXTRACT(YEAR FROM now())::INT;
    v_n    INT;
BEGIN
    INSERT INTO correlativos (prefijo, anio, ultimo) VALUES (p_prefijo, v_anio, 1)
    ON CONFLICT (prefijo, anio) DO UPDATE SET ultimo = correlativos.ultimo + 1
    RETURNING ultimo INTO v_n;
    RETURN p_prefijo || '-' || v_anio || '-' || lpad(v_n::TEXT, 4, '0');
END $$;

-- ---------------------------------------------------------------------
-- 1. USUARIOS: cuatro roles
--    Parcial:  'cliente' = vendedor · 'administrador' = supervisor
--    Final:    'vendedor' · 'supervisor' · 'agente' (servicio) · 'cliente' (Portal)
-- ---------------------------------------------------------------------
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
UPDATE usuarios SET rol = CASE rol WHEN 'cliente' THEN 'vendedor'
                                   WHEN 'administrador' THEN 'supervisor'
                                   ELSE rol END;
ALTER TABLE usuarios
    ADD CONSTRAINT usuarios_rol_check CHECK (rol IN ('vendedor', 'supervisor', 'agente', 'cliente')),
    ADD COLUMN IF NOT EXISTS telefono          VARCHAR(15),
    ADD COLUMN IF NOT EXISTS territorio        VARCHAR(60),           -- vendedor: zona que atiende
    ADD COLUMN IF NOT EXISTS es_senior         BOOLEAN NOT NULL DEFAULT FALSE,  -- agente senior (proceso de lealtad)
    ADD COLUMN IF NOT EXISTS consentimiento_en TIMESTAMPTZ;           -- cliente: aceptó el uso de datos (Ley 29733)

-- ---------------------------------------------------------------------
-- 2. CLIENTES (cuentas). Se crea al GANAR un lead o al registrarse en el Portal.
--    El RUC es único: si ya existe, se reutiliza la cuenta (RN-05, RF-P02).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clientes (
    id                SERIAL PRIMARY KEY,
    ruc               CHAR(11)      NOT NULL UNIQUE CHECK (ruc ~ '^(10|15|17|20)[0-9]{9}$'),
    razon_social      VARCHAR(150)  NOT NULL CHECK (length(trim(razon_social)) > 0),
    direccion         VARCHAR(200),
    distrito          VARCHAR(60),
    latitud           NUMERIC(9,6)  CHECK (latitud BETWEEN -90 AND 90),
    longitud          NUMERIC(9,6)  CHECK (longitud BETWEEN -180 AND 180),
    segmento          VARCHAR(30)   NOT NULL DEFAULT 'PYME',
    vendedor_id       INT           REFERENCES usuarios(id),          -- vendedor responsable de la cuenta
    fecha_alta        DATE          NOT NULL DEFAULT CURRENT_DATE,
    -- CRM analítica (los calcula el servicio de ML; la app solo los lee)
    puntaje_valor     SMALLINT      CHECK (puntaje_valor BETWEEN 0 AND 100),   -- valor y lealtad (RFM)
    prob_cancelacion  NUMERIC(4,3)  CHECK (prob_cancelacion BETWEEN 0 AND 1),  -- churn (ML-02)
    factores_riesgo   JSONB,                                                   -- explicación del churn
    cltv              NUMERIC(12,2),
    acepta_ofertas    BOOLEAN       NOT NULL DEFAULT TRUE,                     -- RN-07
    version           INT           NOT NULL DEFAULT 1,
    creado_en         TIMESTAMPTZ   NOT NULL DEFAULT now(),
    actualizado_en    TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clientes_vendedor ON clientes(vendedor_id);

-- Un usuario con rol 'cliente' pertenece a una cuenta (empresa).
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cliente_id INT REFERENCES clientes(id);
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_cliente_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_cliente_check
    CHECK ((rol = 'cliente') = (cliente_id IS NOT NULL));

-- ---------------------------------------------------------------------
-- 3. LEADS: nuevo embudo, canal de origen y puntaje de ML
--    Equivalencia de etapas del parcial:
--      Prospecto → NUEVO · Contactado → CONTACTADO · Propuesta → CALIFICADO
--      Negociación → COTIZADO · Cerrado → GANADO
-- ---------------------------------------------------------------------
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_etapa_check;
UPDATE leads SET etapa = CASE etapa WHEN 'Prospecto'   THEN 'NUEVO'
                                    WHEN 'Contactado'  THEN 'CONTACTADO'
                                    WHEN 'Propuesta'   THEN 'CALIFICADO'
                                    WHEN 'Negociación' THEN 'COTIZADO'
                                    WHEN 'Cerrado'     THEN 'GANADO'
                                    ELSE etapa END;
ALTER TABLE leads
    ADD CONSTRAINT leads_etapa_check
        CHECK (etapa IN ('NUEVO', 'CONTACTADO', 'CALIFICADO', 'COTIZADO', 'GANADO', 'PERDIDO')),
    ADD COLUMN IF NOT EXISTS telefono            VARCHAR(15),
    ADD COLUMN IF NOT EXISTS correo              VARCHAR(120),
    ADD COLUMN IF NOT EXISTS ruc                 CHAR(11) CHECK (ruc ~ '^[0-9]{11}$'),
    ADD COLUMN IF NOT EXISTS canal_origen        VARCHAR(10) NOT NULL DEFAULT 'VENDEDOR'
        CHECK (canal_origen IN ('VENDEDOR', 'PORTAL', 'CAMPANA')),
    ADD COLUMN IF NOT EXISTS codigo_seguimiento  VARCHAR(15) UNIQUE,                 -- SOL-AAAA-NNNN (solo Portal)
    ADD COLUMN IF NOT EXISTS comentario_cliente  TEXT,                               -- lo que pidió en el Portal
    ADD COLUMN IF NOT EXISTS puntaje             SMALLINT CHECK (puntaje BETWEEN 0 AND 100),   -- ML-01
    ADD COLUMN IF NOT EXISTS puntaje_factores    JSONB,
    ADD COLUMN IF NOT EXISTS motivo_perdida      VARCHAR(120),
    ADD COLUMN IF NOT EXISTS cliente_id          INT REFERENCES clientes(id),
    ADD COLUMN IF NOT EXISTS ultimo_contacto_en  TIMESTAMPTZ;

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_contacto_check;
ALTER TABLE leads ADD CONSTRAINT leads_contacto_check CHECK (length(trim(contacto)) > 0) NOT VALID; -- RF-V04 (solo filas nuevas)
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_perdido_check;
ALTER TABLE leads ADD CONSTRAINT leads_perdido_check CHECK (etapa <> 'PERDIDO' OR motivo_perdida IS NOT NULL);
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_portal_check;
ALTER TABLE leads ADD CONSTRAINT leads_portal_check  CHECK (canal_origen <> 'PORTAL' OR codigo_seguimiento IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_leads_puntaje ON leads(vendedor_id, puntaje DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_leads_cliente ON leads(cliente_id);

-- Historial del lead (RNF-09 trazabilidad): etapa, reasignación y puntaje.
CREATE TABLE IF NOT EXISTS historial_lead (
    id              BIGSERIAL   PRIMARY KEY,
    lead_id         INT         NOT NULL REFERENCES leads(id),
    campo           VARCHAR(20) NOT NULL CHECK (campo IN ('ETAPA', 'VENDEDOR', 'PUNTAJE')),
    valor_anterior  VARCHAR(60),
    valor_nuevo     VARCHAR(60),
    usuario_id      INT         REFERENCES usuarios(id),   -- NULL = lo hizo el sistema (ML, vencimiento)
    fecha           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_historial_lead ON historial_lead(lead_id, fecha);

-- ---------------------------------------------------------------------
-- 4. INTERACCIONES: WhatsApp y visita, fecha+hora y resultado del contacto
-- ---------------------------------------------------------------------
ALTER TABLE interacciones DROP CONSTRAINT IF EXISTS interacciones_tipo_check;
ALTER TABLE interacciones DROP CONSTRAINT IF EXISTS interacciones_nota_check;
ALTER TABLE interacciones
    ADD CONSTRAINT interacciones_tipo_check
        CHECK (tipo IN ('Llamada', 'WhatsApp', 'Correo', 'Reunión', 'Visita')),
    ADD CONSTRAINT interacciones_nota_check
        CHECK (tipo <> 'Reunión' OR length(trim(nota)) > 0),          -- RF-V06: nota obligatoria en reuniones
    ADD COLUMN IF NOT EXISTS fecha_hora TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS resultado  VARCHAR(15)
        CHECK (resultado IN ('CONTESTO', 'NO_CONTESTO', 'INTERESADO', 'NO_INTERESADO'));
ALTER TABLE interacciones ALTER COLUMN nota SET DEFAULT '';
UPDATE interacciones SET fecha_hora = fecha::TIMESTAMP AT TIME ZONE 'America/Lima' WHERE fecha_hora IS NULL;
ALTER TABLE interacciones ALTER COLUMN fecha_hora SET NOT NULL;
ALTER TABLE interacciones ALTER COLUMN fecha_hora SET DEFAULT now();

-- ---------------------------------------------------------------------
-- 5. TAREAS: seguimiento o retención (la crea el supervisor desde la lista de riesgo)
-- ---------------------------------------------------------------------
ALTER TABLE tareas
    ADD COLUMN IF NOT EXISTS tipo        VARCHAR(12) NOT NULL DEFAULT 'SEGUIMIENTO'
        CHECK (tipo IN ('SEGUIMIENTO', 'RETENCION')),
    ADD COLUMN IF NOT EXISTS asignada_a  INT REFERENCES usuarios(id),
    ADD COLUMN IF NOT EXISTS creada_por  INT REFERENCES usuarios(id);

-- ---------------------------------------------------------------------
-- 6. CATÁLOGO DE PRODUCTOS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS productos (
    id          SERIAL PRIMARY KEY,
    codigo      VARCHAR(12)   NOT NULL UNIQUE,
    nombre      VARCHAR(120)  NOT NULL,
    categoria   VARCHAR(30)   NOT NULL CHECK (categoria IN ('LICENCIA', 'MODULO', 'SERVICIO', 'CAPACITACION')),
    precio      NUMERIC(10,2) NOT NULL CHECK (precio >= 0),
    margen_pct  NUMERIC(5,2)  NOT NULL DEFAULT 0 CHECK (margen_pct BETWEEN 0 AND 100),
    activo      BOOLEAN       NOT NULL DEFAULT TRUE
);

-- ---------------------------------------------------------------------
-- 7. COTIZACIONES y su DETALLE
--    Total = Σ(precio × cantidad) × (1 − descuento)            (RF-V08)
--    Descuento > 10 % necesita aprobación del supervisor          (RN-03)
--    Vigencia de 15 días; vencida no se puede aceptar             (RN-04)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cotizaciones (
    id               SERIAL PRIMARY KEY,
    uuid             UUID          NOT NULL UNIQUE,
    numero           VARCHAR(15)   NOT NULL UNIQUE,                 -- COT-AAAA-NNNN
    lead_id          INT           NOT NULL REFERENCES leads(id),
    vendedor_id      INT           NOT NULL REFERENCES usuarios(id),
    subtotal         NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
    descuento_pct    NUMERIC(5,2)  NOT NULL DEFAULT 0 CHECK (descuento_pct BETWEEN 0 AND 50),
    total            NUMERIC(12,2) NOT NULL DEFAULT 0,
    estado           VARCHAR(16)   NOT NULL DEFAULT 'BORRADOR'
                     CHECK (estado IN ('BORRADOR', 'PEND_APROBACION', 'ENVIADA', 'ACEPTADA', 'RECHAZADA', 'VENCIDA')),
    vigencia_hasta   DATE,
    aprobada_por     INT           REFERENCES usuarios(id),
    motivo_rechazo   VARCHAR(12)   CHECK (motivo_rechazo IN ('PRECIO', 'PLAZO', 'OTRA_EMPRESA', 'OTRO')),
    comentario_rechazo VARCHAR(300),
    enviada_en       TIMESTAMPTZ,
    respondida_en    TIMESTAMPTZ,
    version          INT           NOT NULL DEFAULT 1,
    eliminado        BOOLEAN       NOT NULL DEFAULT FALSE,
    creado_en        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    actualizado_en   TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT cot_total_check     CHECK (total = round(subtotal * (1 - descuento_pct / 100), 2)),
    CONSTRAINT cot_rechazo_check   CHECK (estado <> 'RECHAZADA' OR motivo_rechazo IS NOT NULL),
    CONSTRAINT cot_aprobacion_check CHECK (descuento_pct <= 10 OR estado IN ('BORRADOR', 'PEND_APROBACION') OR aprobada_por IS NOT NULL),
    CONSTRAINT cot_envio_check     CHECK (estado IN ('BORRADOR', 'PEND_APROBACION') OR (enviada_en IS NOT NULL AND vigencia_hasta IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_cotizaciones_lead ON cotizaciones(lead_id);
CREATE INDEX IF NOT EXISTS idx_cotizaciones_estado ON cotizaciones(estado);

CREATE TABLE IF NOT EXISTS cotizacion_detalle (
    id              SERIAL PRIMARY KEY,
    cotizacion_id   INT           NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
    producto_id     INT           NOT NULL REFERENCES productos(id),
    cantidad        INT           NOT NULL CHECK (cantidad > 0),
    precio_unit     NUMERIC(10,2) NOT NULL CHECK (precio_unit >= 0),       -- precio congelado al cotizar
    subtotal        NUMERIC(12,2) GENERATED ALWAYS AS (cantidad * precio_unit) STORED,
    UNIQUE (cotizacion_id, producto_id)
);

-- El subtotal y el total de la cotización siempre salen del detalle (no se pueden "inventar").
CREATE OR REPLACE FUNCTION recalcular_cotizacion() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_id INT := COALESCE(NEW.cotizacion_id, OLD.cotizacion_id);
BEGIN
    UPDATE cotizaciones c
       SET subtotal = s.suma,
           total    = round(s.suma * (1 - c.descuento_pct / 100), 2)
      FROM (SELECT COALESCE(sum(subtotal), 0) AS suma FROM cotizacion_detalle WHERE cotizacion_id = v_id) s
     WHERE c.id = v_id;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_detalle_recalcula ON cotizacion_detalle;
CREATE TRIGGER trg_detalle_recalcula AFTER INSERT OR UPDATE OR DELETE ON cotizacion_detalle
    FOR EACH ROW EXECUTE FUNCTION recalcular_cotizacion();

-- ---------------------------------------------------------------------
-- 8. VISITAS en campo (ruta del día + check-in con GPS)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS visitas (
    id                SERIAL PRIMARY KEY,
    uuid              UUID          NOT NULL UNIQUE,
    lead_id           INT           NOT NULL REFERENCES leads(id),
    vendedor_id       INT           NOT NULL REFERENCES usuarios(id),
    fecha_programada  DATE          NOT NULL,
    checkin_en        TIMESTAMPTZ,                                  -- NULL = aún no visitado
    latitud           NUMERIC(9,6)  CHECK (latitud BETWEEN -90 AND 90),
    longitud          NUMERIC(9,6)  CHECK (longitud BETWEEN -180 AND 180),
    precision_m       NUMERIC(7,1),
    distancia_m       NUMERIC(9,1)  CHECK (distancia_m >= 0),
    motivo_distancia  VARCHAR(200),
    version           INT           NOT NULL DEFAULT 1,
    eliminado         BOOLEAN       NOT NULL DEFAULT FALSE,
    creado_en         TIMESTAMPTZ   NOT NULL DEFAULT now(),
    actualizado_en    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT visita_gps_check CHECK (checkin_en IS NULL OR (latitud IS NOT NULL AND longitud IS NOT NULL)),
    CONSTRAINT visita_300m_check CHECK (distancia_m IS NULL OR distancia_m <= 300 OR motivo_distancia IS NOT NULL)  -- RF-V13
);
CREATE INDEX IF NOT EXISTS idx_visitas_ruta ON visitas(vendedor_id, fecha_programada);

-- ---------------------------------------------------------------------
-- 9. SERVICIO AL CLIENTE: solicitudes (tickets) y su historial
--    Proceso de lealtad (Laudon fig. 9.9): puntaje ≥ 70 → prioridad ALTA, SLA 4 h, agente senior.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS solicitudes_servicio (
    id               SERIAL PRIMARY KEY,
    uuid             UUID          NOT NULL UNIQUE,
    numero           VARCHAR(15)   NOT NULL UNIQUE,                 -- SRV-AAAA-NNNN
    cliente_id       INT           NOT NULL REFERENCES clientes(id),
    creada_por       INT           NOT NULL REFERENCES usuarios(id),
    categoria        VARCHAR(20)   NOT NULL CHECK (categoria IN ('FACTURACION', 'ACCESO', 'ERROR_SISTEMA', 'CAPACITACION', 'OTRO')),
    descripcion      TEXT          NOT NULL CHECK (length(trim(descripcion)) >= 20),   -- RF-P07
    foto_url         VARCHAR(300),
    puntaje_cliente  SMALLINT      CHECK (puntaje_cliente BETWEEN 0 AND 100),         -- foto del puntaje al abrir
    prioridad        VARCHAR(6)    NOT NULL CHECK (prioridad IN ('ALTA', 'NORMAL')),
    agente_id        INT           REFERENCES usuarios(id),          -- NULL = cola general
    estado           VARCHAR(12)   NOT NULL DEFAULT 'ABIERTA'
                     CHECK (estado IN ('ABIERTA', 'EN_ATENCION', 'RESUELTA', 'CERRADA')),
    sla_hasta        TIMESTAMPTZ   NOT NULL,
    solucion         TEXT,
    resuelta_en      TIMESTAMPTZ,
    cerrada_en       TIMESTAMPTZ,
    calificacion     SMALLINT      CHECK (calificacion BETWEEN 1 AND 5),           -- RF-P12
    comentario_calif VARCHAR(300),
    calificada_en    TIMESTAMPTZ,
    version          INT           NOT NULL DEFAULT 1,
    creado_en        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    actualizado_en   TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT srv_prioridad_check CHECK (prioridad = CASE WHEN puntaje_cliente >= 70 THEN 'ALTA' ELSE 'NORMAL' END), -- RN-06
    CONSTRAINT srv_calif_check     CHECK (calificacion IS NULL OR estado IN ('RESUELTA', 'CERRADA')),
    CONSTRAINT srv_resuelta_check  CHECK (estado NOT IN ('RESUELTA', 'CERRADA') OR (resuelta_en IS NOT NULL AND solucion IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_srv_cola ON solicitudes_servicio(estado, prioridad, creado_en);
CREATE INDEX IF NOT EXISTS idx_srv_cliente ON solicitudes_servicio(cliente_id);

CREATE TABLE IF NOT EXISTS eventos_solicitud (
    id              BIGSERIAL   PRIMARY KEY,
    solicitud_id    INT         NOT NULL REFERENCES solicitudes_servicio(id),
    estado_anterior VARCHAR(12),
    estado_nuevo    VARCHAR(12) NOT NULL,
    nota            VARCHAR(300),
    usuario_id      INT         REFERENCES usuarios(id),
    fecha           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eventos_solicitud ON eventos_solicitud(solicitud_id, fecha);

-- ---------------------------------------------------------------------
-- 10. MARKETING: campañas y envíos/respuestas por canal (Laudon fig. 9.7)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campanas (
    id             SERIAL PRIMARY KEY,
    nombre         VARCHAR(100)  NOT NULL,
    segmento       JSONB         NOT NULL,          -- filtro: {"tieneProducto":"FAC","sinProducto":"INV","segmento":"PYME"}
    oferta         VARCHAR(200)  NOT NULL,
    producto_id    INT           REFERENCES productos(id),
    descuento_pct  NUMERIC(5,2)  NOT NULL DEFAULT 0 CHECK (descuento_pct BETWEEN 0 AND 50),
    canales        VARCHAR(10)[] NOT NULL CHECK (cardinality(canales) > 0
                     AND canales <@ ARRAY['PUSH', 'WHATSAPP', 'CORREO', 'LLAMADA', 'VISITA']::VARCHAR(10)[]),
    inicio         DATE          NOT NULL,
    fin            DATE          NOT NULL,
    estado         VARCHAR(10)   NOT NULL DEFAULT 'BORRADOR' CHECK (estado IN ('BORRADOR', 'ENVIADA', 'FINALIZADA')),
    creada_por     INT           NOT NULL REFERENCES usuarios(id),
    creado_en      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT campana_fechas_check CHECK (fin >= inicio)
);

-- Un registro por cliente y canal: se crea al ENVIAR y se completa si el cliente RESPONDE.
CREATE TABLE IF NOT EXISTS respuestas_campana (
    id             SERIAL PRIMARY KEY,
    campana_id     INT          NOT NULL REFERENCES campanas(id),
    cliente_id     INT          NOT NULL REFERENCES clientes(id),
    canal          VARCHAR(10)  NOT NULL CHECK (canal IN ('PUSH', 'WHATSAPP', 'CORREO', 'LLAMADA', 'VISITA')),
    enviado_en     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    respondio      BOOLEAN      NOT NULL DEFAULT FALSE,
    respondido_en  TIMESTAMPTZ,
    lead_id        INT          REFERENCES leads(id),              -- lead generado por el "Me interesa"
    UNIQUE (campana_id, cliente_id, canal),
    CONSTRAINT resp_check CHECK (respondio = (respondido_en IS NOT NULL))
);

-- El lead que nace de una campaña sabe de cuál vino.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS campana_id INT REFERENCES campanas(id);
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_campana_check;
ALTER TABLE leads ADD CONSTRAINT leads_campana_check CHECK (canal_origen <> 'CAMPANA' OR campana_id IS NOT NULL);

-- ---------------------------------------------------------------------
-- 11. RECOMENDACIONES (ML-04, venta cruzada) y DISPOSITIVOS (notificaciones push)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recomendaciones (
    cliente_id   INT          NOT NULL REFERENCES clientes(id),
    producto_id  INT          NOT NULL REFERENCES productos(id),
    confianza    NUMERIC(4,3) NOT NULL CHECK (confianza BETWEEN 0 AND 1),
    lift         NUMERIC(6,3),
    razon        VARCHAR(200) NOT NULL,          -- "Clientes que compraron Facturación también compraron Inventario"
    generado_en  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (cliente_id, producto_id)
);

CREATE TABLE IF NOT EXISTS dispositivos (
    token_fcm       VARCHAR(255) PRIMARY KEY,
    usuario_id      INT          NOT NULL REFERENCES usuarios(id),
    app             VARCHAR(12)  NOT NULL CHECK (app IN ('VENDEDOR', 'PORTAL', 'SUPERVISOR')),
    actualizado_en  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 12. REGLAS DE NEGOCIO EN LA BASE (además de validarlas en la API)
-- ---------------------------------------------------------------------

-- RN-02: el canal de origen no cambia · Transiciones válidas del embudo · Historial automático
CREATE OR REPLACE FUNCTION reglas_lead() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    orden CONSTANT TEXT[] := ARRAY['NUEVO', 'CONTACTADO', 'CALIFICADO', 'COTIZADO', 'GANADO'];
    usuario INT := NULLIF(current_setting('crm.usuario_id', TRUE), '')::INT;  -- la API lo fija con SET LOCAL
BEGIN
    IF NEW.canal_origen IS DISTINCT FROM OLD.canal_origen THEN
        RAISE EXCEPTION 'RN-02: el canal de origen de un lead no se puede modificar' USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.etapa IS DISTINCT FROM OLD.etapa THEN
        IF OLD.etapa = 'GANADO' THEN
            RAISE EXCEPTION 'Un lead GANADO no cambia de etapa' USING ERRCODE = 'check_violation';
        ELSIF NEW.etapa = 'PERDIDO' THEN
            NULL;                                                  -- desde cualquier etapa abierta, con motivo
        ELSIF OLD.etapa = 'PERDIDO' THEN
            IF NEW.etapa <> 'NUEVO' THEN
                RAISE EXCEPTION 'Un lead PERDIDO solo se reactiva como NUEVO' USING ERRCODE = 'check_violation';
            END IF;
        ELSIF array_position(orden, NEW.etapa) < array_position(orden, OLD.etapa)
              AND NOT (OLD.etapa = 'COTIZADO' AND NEW.etapa = 'CALIFICADO') THEN   -- recotizar tras un rechazo
            RAISE EXCEPTION 'Transición no permitida: % → %', OLD.etapa, NEW.etapa USING ERRCODE = 'check_violation';
        END IF;
        INSERT INTO historial_lead (lead_id, campo, valor_anterior, valor_nuevo, usuario_id)
        VALUES (NEW.id, 'ETAPA', OLD.etapa, NEW.etapa, usuario);
    END IF;

    IF NEW.vendedor_id IS DISTINCT FROM OLD.vendedor_id THEN
        INSERT INTO historial_lead (lead_id, campo, valor_anterior, valor_nuevo, usuario_id)
        VALUES (NEW.id, 'VENDEDOR', OLD.vendedor_id::TEXT, NEW.vendedor_id::TEXT, usuario);
    END IF;

    IF NEW.puntaje IS DISTINCT FROM OLD.puntaje THEN
        INSERT INTO historial_lead (lead_id, campo, valor_anterior, valor_nuevo, usuario_id)
        VALUES (NEW.id, 'PUNTAJE', OLD.puntaje::TEXT, NEW.puntaje::TEXT, NULL);
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_reglas_lead ON leads;
CREATE TRIGGER trg_reglas_lead BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION reglas_lead();

-- Estados de la cotización y RN-04 (no se acepta vencida)
CREATE OR REPLACE FUNCTION reglas_cotizacion() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.estado IS DISTINCT FROM OLD.estado THEN
        IF NOT (
            (OLD.estado = 'BORRADOR'        AND NEW.estado IN ('PEND_APROBACION', 'ENVIADA')) OR
            (OLD.estado = 'PEND_APROBACION' AND NEW.estado IN ('ENVIADA', 'BORRADOR'))        OR
            (OLD.estado = 'ENVIADA'         AND NEW.estado IN ('ACEPTADA', 'RECHAZADA', 'VENCIDA'))
        ) THEN
            RAISE EXCEPTION 'Cambio de estado no permitido: % → %', OLD.estado, NEW.estado USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.estado = 'ACEPTADA' AND NEW.vigencia_hasta < CURRENT_DATE THEN
            RAISE EXCEPTION 'RN-04: la cotización está vencida y no puede aceptarse' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_reglas_cotizacion ON cotizaciones;
CREATE TRIGGER trg_reglas_cotizacion BEFORE UPDATE ON cotizaciones FOR EACH ROW EXECUTE FUNCTION reglas_cotizacion();

-- Estados del ticket + historial automático
CREATE OR REPLACE FUNCTION reglas_solicitud() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO eventos_solicitud (solicitud_id, estado_anterior, estado_nuevo, usuario_id)
        VALUES (NEW.id, NULL, NEW.estado, NEW.creada_por);
        RETURN NEW;
    END IF;
    IF NEW.estado IS DISTINCT FROM OLD.estado THEN
        IF NOT (
            (OLD.estado = 'ABIERTA'     AND NEW.estado = 'EN_ATENCION') OR
            (OLD.estado = 'EN_ATENCION' AND NEW.estado IN ('RESUELTA', 'ABIERTA')) OR
            (OLD.estado = 'RESUELTA'    AND NEW.estado IN ('CERRADA', 'EN_ATENCION'))   -- el cliente puede reabrir
        ) THEN
            RAISE EXCEPTION 'Cambio de estado no permitido: % → %', OLD.estado, NEW.estado USING ERRCODE = 'check_violation';
        END IF;
        INSERT INTO eventos_solicitud (solicitud_id, estado_anterior, estado_nuevo, usuario_id)
        VALUES (NEW.id, OLD.estado, NEW.estado, NULLIF(current_setting('crm.usuario_id', TRUE), '')::INT);
    END IF;
    IF OLD.calificacion IS NOT NULL AND NEW.calificacion IS DISTINCT FROM OLD.calificacion THEN
        RAISE EXCEPTION 'RF-P12: el ticket ya fue calificado' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_reglas_solicitud ON solicitudes_servicio;
CREATE TRIGGER trg_reglas_solicitud AFTER INSERT ON solicitudes_servicio FOR EACH ROW EXECUTE FUNCTION reglas_solicitud();
DROP TRIGGER IF EXISTS trg_reglas_solicitud_upd ON solicitudes_servicio;
CREATE TRIGGER trg_reglas_solicitud_upd BEFORE UPDATE ON solicitudes_servicio FOR EACH ROW EXECUTE FUNCTION reglas_solicitud();

-- RN-07: los clientes sin ofertas no entran en ninguna campaña
CREATE OR REPLACE FUNCTION reglas_envio_campana() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NOT (SELECT acepta_ofertas FROM clientes WHERE id = NEW.cliente_id) THEN
        RAISE EXCEPTION 'RN-07: el cliente % desactivó las ofertas', NEW.cliente_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_envio_campana ON respuestas_campana;
CREATE TRIGGER trg_envio_campana BEFORE INSERT ON respuestas_campana FOR EACH ROW EXECUTE FUNCTION reglas_envio_campana();

-- ---------------------------------------------------------------------
-- 13. VISTAS de apoyo (las usa la API; las métricas completas van en el modelo estrella, Semana 14)
-- ---------------------------------------------------------------------

-- Cartera del vendedor: días sin contacto (RF-V03) y orden por puntaje (RF-V01).
CREATE OR REPLACE VIEW v_cartera AS
SELECT l.*,
       COALESCE(EXTRACT(DAY FROM now() - GREATEST(l.ultimo_contacto_en, l.creado_en))::INT, 0) AS dias_sin_contacto
FROM leads l
WHERE l.eliminado = FALSE AND l.etapa NOT IN ('GANADO', 'PERDIDO');

-- Historial de compras del cliente (RF-V15) = cotizaciones aceptadas.
CREATE OR REPLACE VIEW v_compras_cliente AS
SELECT c.id AS cliente_id, co.id AS cotizacion_id, co.numero, co.respondida_en AS fecha,
       d.producto_id, p.nombre AS producto, d.cantidad, d.subtotal
FROM clientes c
JOIN leads l          ON l.cliente_id = c.id
JOIN cotizaciones co  ON co.lead_id = l.id AND co.estado = 'ACEPTADA'
JOIN cotizacion_detalle d ON d.cotizacion_id = co.id
JOIN productos p      ON p.id = d.producto_id;

-- Respuestas por canal de cada campaña (RF-S08).
CREATE OR REPLACE VIEW v_respuestas_por_canal AS
SELECT campana_id, canal,
       count(*)                                   AS enviados,
       count(*) FILTER (WHERE respondio)          AS respuestas,
       round(100.0 * count(*) FILTER (WHERE respondio) / NULLIF(count(*), 0), 1) AS tasa_respuesta
FROM respuestas_campana
GROUP BY campana_id, canal;

COMMIT;
