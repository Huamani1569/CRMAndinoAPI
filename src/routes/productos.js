// GET /api/productos → catálogo activo (las tres apps lo guardan en Room)
const express = require('express');
const { query } = require('../db');

const router = express.Router();

router.get('/', async (req, res, next) => {
    try {
        const par = [];
        let filtro = 'WHERE activo';
        if (req.query.categoria) { par.push(String(req.query.categoria)); filtro += ' AND categoria = $1'; }
        const r = await query(`SELECT id, codigo, nombre, categoria, precio::float8 AS precio FROM productos ${filtro} ORDER BY categoria, nombre`, par);
        res.json({ servidorTiempo: new Date().toISOString(), total: r.rowCount, datos: r.rows });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
