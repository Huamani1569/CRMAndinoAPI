// Rutas de apoyo para la DEMOSTRACIÓN en clase (se abren desde el navegador de la laptop).
//   GET /api/dev/falla?activar=1   → simula que el servidor está caído (responde 503)
//   GET /api/dev/falla?activar=0   → el servidor vuelve a funcionar
//   GET /api/dev/estado            → conteo de registros y últimas operaciones recibidas
const express = require('express');
const { query } = require('../db');
const { estadoFalla, cambiarFalla } = require('../middleware/fallaSimulada');

const router = express.Router();

router.get('/falla', (req, res) => {
    if (req.query.activar !== undefined) cambiarFalla(req.query.activar === '1' || req.query.activar === 'true');
    res.json({
        fallaActiva: estadoFalla(),
        mensaje: estadoFalla()
            ? 'FALLA SIMULADA ACTIVA: la API responde 503 a las apps.'
            : 'La API funciona con normalidad.'
    });
});

router.get('/estado', async (req, res, next) => {
    try {
        const conteos = await query(`
            SELECT
              (SELECT count(*) FROM usuarios)::int                                 AS usuarios,
              (SELECT count(*) FROM leads WHERE eliminado = FALSE)::int            AS leads,
              (SELECT count(*) FROM leads WHERE eliminado = TRUE)::int             AS leads_eliminados,
              (SELECT count(*) FROM interacciones WHERE eliminado = FALSE)::int    AS interacciones,
              (SELECT count(*) FROM tareas WHERE eliminado = FALSE)::int           AS tareas,
              (SELECT count(*) FROM operaciones_procesadas)::int                   AS operaciones_procesadas`);
        const ultimas = await query(`
            SELECT o.uuid_operacion, u.nombre AS usuario, o.entidad, o.tipo_operacion, o.codigo_http,
                   o.respuesta->>'mensaje' AS mensaje, o.procesada_en
            FROM operaciones_procesadas o JOIN usuarios u ON u.id = o.usuario_id
            ORDER BY o.procesada_en DESC LIMIT 15`);
        res.json({ fallaActiva: estadoFalla(), conteos: conteos.rows[0], ultimasOperaciones: ultimas.rows });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
