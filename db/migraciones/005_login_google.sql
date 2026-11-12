-- =====================================================================
-- Migración 005 · Semana 15-16: inicio de sesión con Google (API externa) en el Portal del Cliente.
-- Se guarda el identificador de la cuenta de Google ("sub") para vincularla al usuario.
-- =====================================================================
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS google_sub VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_google_sub ON usuarios (google_sub) WHERE google_sub IS NOT NULL;
