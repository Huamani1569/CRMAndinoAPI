// Error "controlado" que se convierte en una respuesta HTTP con un mensaje claro para la app.
class ErrorHttp extends Error {
    constructor(status, codigo, mensaje, extra = {}) {
        super(mensaje);
        this.status = status;   // 400, 403, 404, 409, 422...
        this.codigo = codigo;   // código corto que la app puede interpretar
        this.extra = extra;     // datos adicionales (por ejemplo, la versión actual del servidor)
    }

    cuerpo() {
        return { error: this.codigo, mensaje: this.message, ...this.extra };
    }
}

// Proyecto Final: embudo y roles ampliados (ver db/migraciones/001_proyecto_final.sql)
const ETAPAS = ['NUEVO', 'CONTACTADO', 'CALIFICADO', 'COTIZADO', 'GANADO', 'PERDIDO'];
const ETAPAS_ABIERTAS = ['NUEVO', 'CONTACTADO', 'CALIFICADO', 'COTIZADO'];
const TIPOS_INTERACCION = ['Llamada', 'WhatsApp', 'Correo', 'Reunión', 'Visita'];
const RESULTADOS_CONTACTO = ['CONTESTO', 'NO_CONTESTO', 'INTERESADO', 'NO_INTERESADO'];
const ROL_VENDEDOR = 'vendedor';
const ROL_SUPERVISOR = 'supervisor';
const ROL_AGENTE = 'agente';
const ROL_CLIENTE = 'cliente';

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGEX_FECHA = /^\d{4}-\d{2}-\d{2}$/;

function esUuid(valor) {
    return typeof valor === 'string' && REGEX_UUID.test(valor);
}

function esFechaIso(valor) {
    if (typeof valor !== 'string' || !REGEX_FECHA.test(valor)) return false;
    const fecha = new Date(valor + 'T00:00:00Z');
    return !Number.isNaN(fecha.getTime()) && fecha.toISOString().startsWith(valor);
}

// Fecha y hora ISO completa (2026-11-11T15:30:00Z o con zona horaria)
function esFechaHoraIso(valor) {
    return typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(valor) && !Number.isNaN(new Date(valor).getTime());
}

// Hoy en Lima (AAAA-MM-DD), para no aceptar fechas pasadas
function hoyLima() {
    return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

module.exports = {
    ErrorHttp, ETAPAS, ETAPAS_ABIERTAS, TIPOS_INTERACCION, RESULTADOS_CONTACTO,
    ROL_VENDEDOR, ROL_SUPERVISOR, ROL_AGENTE, ROL_CLIENTE, esUuid, esFechaIso, esFechaHoraIso, hoyLima
};
