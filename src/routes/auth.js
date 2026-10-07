// POST /api/auth/login  →  autentica contra la tabla usuarios de la BD remota.
const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { generarToken } = require('../middleware/auth');

const router = express.Router();

router.post('/login', async (req, res, next) => {
    try {
        const correo = String(req.body.correo || '').trim().toLowerCase();
        const clave = String(req.body.clave || '');
        const rolEsperado = req.body.rolEsperado; // la app indica qué rol puede entrar en ella

        if (!correo || !clave) {
            return res.status(400).json({ error: 'DATOS_INCOMPLETOS', mensaje: 'Ingresa correo y contraseña.' });
        }

        const resultado = await query(
            'SELECT id, nombre, correo, clave_hash, rol, activo FROM usuarios WHERE correo = $1',
            [correo]
        );
        const usuario = resultado.rows[0];

        // Se compara la clave con el hash bcrypt guardado (la clave nunca se guarda en texto plano).
        if (!usuario || !usuario.activo || !(await bcrypt.compare(clave, usuario.clave_hash))) {
            return res.status(401).json({ error: 'CREDENCIALES_INVALIDAS', mensaje: 'Correo o contraseña incorrectos.' });
        }

        if (rolEsperado && usuario.rol !== rolEsperado) {
            return res.status(403).json({
                error: 'ROL_NO_PERMITIDO',
                mensaje: 'Esta cuenta no tiene acceso a esta aplicación.'
            });
        }

        res.json({
            token: generarToken(usuario),
            usuario: { id: usuario.id, nombre: usuario.nombre, correo: usuario.correo, rol: usuario.rol }
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
