// Permite SIMULAR que el servidor está caído (para la prueba "error del servidor" de la guía).
// Activar:    GET http://localhost:3000/api/dev/falla?activar=1
// Desactivar: GET http://localhost:3000/api/dev/falla?activar=0
let fallaActiva = false;

function estadoFalla() {
    return fallaActiva;
}

function cambiarFalla(valor) {
    fallaActiva = valor;
}

// Mientras la falla está activa, todas las rutas (menos /api/dev) responden 503.
function middlewareFalla(req, res, next) {
    if (fallaActiva && !req.path.startsWith('/api/dev')) {
        return res.status(503).json({
            error: 'SERVIDOR_NO_DISPONIBLE',
            mensaje: 'El servidor no está disponible en este momento (falla simulada).'
        });
    }
    next();
}

module.exports = { estadoFalla, cambiarFalla, middlewareFalla };
