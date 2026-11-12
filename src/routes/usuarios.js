// GET /api/usuarios/vendedores → vendedores activos con su carga (para reasignar leads y tareas)
// GET /api/usuarios/agentes    → agentes de servicio con sus tickets abiertos
const express = require('express');
const { query } = require('../db');
const { permitirRoles } = require('../middleware/auth');
const { ROL_SUPERVISOR, ROL_AGENTE } = require('../errores');

const router = express.Router();

router.get('/vendedores', permitirRoles(ROL_SUPERVISOR), async (req, res, next) => {
    try {
        const r = await query(`
            SELECT u.id, u.nombre, u.correo, u.rol, u.territorio,
                   count(l.id) FILTER (WHERE l.etapa NOT IN ('GANADO','PERDIDO'))::int AS leads_abiertos
            FROM usuarios u LEFT JOIN leads l ON l.vendedor_id = u.id AND NOT l.eliminado
            WHERE u.rol = 'vendedor' AND u.activo GROUP BY u.id ORDER BY u.nombre`);
        res.json({ servidorTiempo: new Date().toISOString(), total: r.rowCount,
            datos: r.rows.map(f => ({ id: f.id, nombre: f.nombre, correo: f.correo, rol: f.rol, territorio: f.territorio, leadsAbiertos: f.leads_abiertos })) });
    } catch (error) {
        next(error);
    }
});

router.get('/agentes', permitirRoles(ROL_SUPERVISOR, ROL_AGENTE), async (req, res, next) => {
    try {
        const r = await query(`
            SELECT u.id, u.nombre, u.es_senior,
                   count(s.id) FILTER (WHERE s.estado IN ('ABIERTA','EN_ATENCION'))::int AS abiertas
            FROM usuarios u LEFT JOIN solicitudes_servicio s ON s.agente_id = u.id
            WHERE u.rol = 'agente' AND u.activo GROUP BY u.id ORDER BY u.nombre`);
        res.json({ total: r.rowCount, datos: r.rows.map(f => ({ id: f.id, nombre: f.nombre, esSenior: f.es_senior, ticketsAbiertos: f.abiertas })) });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
