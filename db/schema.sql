-- =====================================================================
-- CRM Andino Perú — Esquema de la BASE DE DATOS REMOTA (PostgreSQL / Neon)
-- Las apps móviles NUNCA se conectan aquí directamente: solo la API REST.
-- =====================================================================

-- Usuarios autorizados. La clave se guarda como hash bcrypt (nunca en texto plano).
--   rol 'cliente'       -> VENDEDOR   (usa la app CRM Andino Vendedor)
--   rol 'administrador' -> SUPERVISOR (usa la app CRM Andino Supervisor)
CREATE TABLE IF NOT EXISTS usuarios (
    id          SERIAL PRIMARY KEY,
    nombre      VARCHAR(100) NOT NULL,
    correo      VARCHAR(120) NOT NULL UNIQUE,
    clave_hash  VARCHAR(100) NOT NULL,
    rol         VARCHAR(20)  NOT NULL CHECK (rol IN ('cliente', 'administrador')),
    activo      BOOLEAN      NOT NULL DEFAULT TRUE,
    creado_en   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Leads (clientes potenciales del embudo de ventas).
--   uuid      -> identificador global generado en el celular (evita duplicados)
--   version   -> aumenta en cada cambio; sirve para detectar conflictos
--   eliminado -> borrado lógico (el supervisor descarta el lead)
CREATE TABLE IF NOT EXISTS leads (
    id               SERIAL PRIMARY KEY,
    uuid             UUID          NOT NULL UNIQUE,
    empresa          VARCHAR(150)  NOT NULL CHECK (length(trim(empresa)) > 0),
    contacto         VARCHAR(120)  NOT NULL DEFAULT '',
    valor_potencial  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (valor_potencial >= 0),
    etapa            VARCHAR(20)   NOT NULL
                     CHECK (etapa IN ('Prospecto', 'Contactado', 'Propuesta', 'Negociación', 'Cerrado')),
    vendedor_id      INT           NOT NULL REFERENCES usuarios(id),
    version          INT           NOT NULL DEFAULT 1,
    eliminado        BOOLEAN       NOT NULL DEFAULT FALSE,
    creado_en        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    actualizado_en   TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_vendedor ON leads(vendedor_id);
CREATE INDEX IF NOT EXISTS idx_leads_actualizado ON leads(actualizado_en);

-- Interacciones con un lead (llamada, correo o reunión).
CREATE TABLE IF NOT EXISTS interacciones (
    id              SERIAL PRIMARY KEY,
    uuid            UUID        NOT NULL UNIQUE,
    lead_id         INT         NOT NULL REFERENCES leads(id),
    tipo            VARCHAR(20) NOT NULL CHECK (tipo IN ('Llamada', 'Correo', 'Reunión')),
    fecha           DATE        NOT NULL,
    nota            TEXT        NOT NULL CHECK (length(trim(nota)) > 0),
    registrado_por  INT         NOT NULL REFERENCES usuarios(id),
    version         INT         NOT NULL DEFAULT 1,
    eliminado       BOOLEAN     NOT NULL DEFAULT FALSE,
    creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_interacciones_lead ON interacciones(lead_id);

-- Tareas / recordatorios de seguimiento con fecha límite.
CREATE TABLE IF NOT EXISTS tareas (
    id              SERIAL PRIMARY KEY,
    uuid            UUID         NOT NULL UNIQUE,
    lead_id         INT          NOT NULL REFERENCES leads(id),
    descripcion     VARCHAR(200) NOT NULL CHECK (length(trim(descripcion)) > 0),
    fecha_limite    DATE         NOT NULL,
    completada      BOOLEAN      NOT NULL DEFAULT FALSE,
    version         INT          NOT NULL DEFAULT 1,
    eliminado       BOOLEAN      NOT NULL DEFAULT FALSE,
    creado_en       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    actualizado_en  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tareas_lead ON tareas(lead_id);

-- Registro de operaciones ya procesadas (IDEMPOTENCIA).
-- Cada escritura que envía el celular trae un uuid_operacion único. Si llega dos veces
-- (reintento, reenvío), el servidor devuelve la respuesta guardada y NO vuelve a ejecutarla.
CREATE TABLE IF NOT EXISTS operaciones_procesadas (
    uuid_operacion  UUID        PRIMARY KEY,
    usuario_id      INT         NOT NULL REFERENCES usuarios(id),
    entidad         VARCHAR(30) NOT NULL,
    tipo_operacion  VARCHAR(10) NOT NULL,
    codigo_http     INT         NOT NULL DEFAULT 0,
    respuesta       JSONB,
    procesada_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);
