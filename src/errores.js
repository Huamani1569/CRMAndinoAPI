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

const ETAPAS = ['Prospecto', 'Contactado', 'Propuesta', 'Negociación', 'Cerrado'];
const TIPOS_INTERACCION = ['Llamada', 'Correo', 'Reunión'];
const ROL_VENDEDOR = 'cliente';
const ROL_SUPERVISOR = 'administrador';

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

module.exports = {
    ErrorHttp, ETAPAS, TIPOS_INTERACCION, ROL_VENDEDOR, ROL_SUPERVISOR, esUuid, esFechaIso
};
