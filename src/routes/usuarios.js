// GET /api/usuarios/vendedores → lista de vendedores (el supervisor la usa para reasignar leads).
const express = require('express');
const { query } = require('../db');
const { permitirRoles } = require('../middleware/auth');
const { ROL_VENDEDOR, ROL_SUPERVISOR } = require('../errores');

const router = express.Router();

router.get('/vendedores', permitirRoles(ROL_SUPERVISOR), async (req, res, next) => {
    try {
        const r = await query(
            'SELECT id, nombre, correo, rol FROM usuarios WHERE rol = $1 AND activo = TRUE ORDER BY nombre',
            [ROL_VENDEDOR]
        );
        res.json({ servidorTiempo: new Date().toISOString(), total: r.rowCount, datos: r.rows });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
