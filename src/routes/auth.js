// POST /api/auth/login  →  autentica contra la tabla usuarios de la BD remota.
// Cada app indica qué roles pueden entrar en ella:
//   App Vendedor   → app: "VENDEDOR"   (rol vendedor)
//   App Portal     → app: "PORTAL"     (rol cliente)
//   App Supervisor → app: "SUPERVISOR" (roles supervisor y agente)
// Compatibilidad con las apps del parcial (Semana 8), que envían rolEsperado:
//   "cliente" (era el vendedor) y "administrador" (era el supervisor).
const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { generarToken } = require('../middleware/auth');

const router = express.Router();

const ROLES_POR_APP = {
    VENDEDOR: ['vendedor'],
    PORTAL: ['cliente'],
    SUPERVISOR: ['supervisor', 'agente']
};
const LEGADO = { cliente: 'vendedor', administrador: 'supervisor' };
const LEGADO_INVERSO = { vendedor: 'cliente', supervisor: 'administrador' };

router.post('/login', async (req, res, next) => {
    try {
        const correo = String(req.body.correo || '').trim().toLowerCase();
        const clave = String(req.body.clave || '');
        const app = req.body.app ? String(req.body.app).toUpperCase() : null;
        const esLegado = !app && typeof req.body.rolEsperado === 'string';

        if (!correo || !clave) {
            return res.status(400).json({ error: 'DATOS_INCOMPLETOS', mensaje: 'Ingresa correo y contraseña.' });
        }

        const resultado = await query(
            `SELECT u.id, u.nombre, u.correo, u.clave_hash, u.rol, u.activo, u.cliente_id, u.es_senior, c.razon_social
             FROM usuarios u LEFT JOIN clientes c ON c.id = u.cliente_id WHERE u.correo = $1`,
            [correo]
        );
        const usuario = resultado.rows[0];

        // Se compara la clave con el hash bcrypt guardado (la clave nunca se guarda en texto plano).
        if (!usuario || !usuario.activo || !(await bcrypt.compare(clave, usuario.clave_hash))) {
            return res.status(401).json({ error: 'CREDENCIALES_INVALIDAS', mensaje: 'Correo o contraseña incorrectos.' });
        }

        let permitidos = null;
        if (app && ROLES_POR_APP[app]) permitidos = ROLES_POR_APP[app];
        else if (esLegado) permitidos = [LEGADO[req.body.rolEsperado] || req.body.rolEsperado];
        else if (Array.isArray(req.body.rolEsperado)) permitidos = req.body.rolEsperado;

        if (permitidos && !permitidos.includes(usuario.rol)) {
            return res.status(403).json({
                error: 'ROL_NO_PERMITIDO',
                mensaje: 'Esta cuenta no tiene acceso a esta aplicación.'
            });
        }

        res.json({
            token: generarToken(usuario),
            usuario: {
                id: usuario.id,
                nombre: usuario.nombre,
                correo: usuario.correo,
                rol: esLegado ? (LEGADO_INVERSO[usuario.rol] || usuario.rol) : usuario.rol,
                clienteId: usuario.cliente_id,
                empresa: usuario.razon_social,
                esSenior: usuario.es_senior
            }
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
