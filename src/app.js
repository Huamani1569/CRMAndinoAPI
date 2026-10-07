// Configuración de la API REST (Express).
const express = require('express');
const cors = require('cors');
const { query } = require('./db');
const { requiereSesion } = require('./middleware/auth');
const { middlewareFalla } = require('./middleware/fallaSimulada');

function crearApp() {
    const app = express();
    app.use(cors());
    app.use(express.json({ limit: '1mb' }));

    // Registro simple de cada petición en la consola (útil para la exposición).
    app.use((req, res, next) => {
        const inicio = Date.now();
        res.on('finish', () => {
            const op = req.get('X-Operacion-UUID');
            const dup = res.get('X-Operacion-Duplicada') === 'true' ? ' [DUPLICADA: no se volvió a ejecutar]' : '';
            console.log(`${new Date().toLocaleTimeString()}  ${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - inicio} ms)${op ? ' op=' + op.slice(0, 8) : ''}${dup}`);
        });
        next();
    });

    app.use(middlewareFalla);

    app.get('/', (req, res) => {
        res.json({
            servicio: 'CRM Andino Perú - API REST',
            endpoints: [
                'GET  /api/salud',
                'POST /api/auth/login',
                'GET|POST /api/leads · GET|PUT|DELETE /api/leads/{id}',
                'GET|POST /api/interacciones · GET|PUT|DELETE /api/interacciones/{id}',
                'GET|POST /api/tareas · GET|PUT|DELETE /api/tareas/{id}',
                'GET  /api/usuarios/vendedores',
                'GET  /api/dev/estado · GET /api/dev/falla?activar=1|0'
            ]
        });
    });

    // Salud: la app la usa para saber si el servidor y la BD responden.
    app.get('/api/salud', async (req, res) => {
        try {
            await query('SELECT 1');
            res.json({ ok: true, baseDatos: 'conectada', hora: new Date().toISOString() });
        } catch (e) {
            res.status(503).json({ ok: false, error: 'BD_NO_DISPONIBLE', mensaje: 'No hay conexión con la base de datos remota.' });
        }
    });

    app.use('/api/auth', require('./routes/auth'));
    app.use('/api/dev', require('./routes/dev'));

    // Todo lo demás requiere sesión (token JWT).
    app.use('/api/leads', requiereSesion, require('./routes/leads'));
    app.use('/api/interacciones', requiereSesion, require('./routes/interacciones'));
    app.use('/api/tareas', requiereSesion, require('./routes/tareas'));
    app.use('/api/usuarios', requiereSesion, require('./routes/usuarios'));

    app.use((req, res) => res.status(404).json({ error: 'RUTA_NO_EXISTE', mensaje: `No existe ${req.method} ${req.path}` }));

    // Errores inesperados → 500 (la app los trata como "error del servidor" y reintenta luego).
    // eslint-disable-next-line no-unused-vars
    app.use((error, req, res, next) => {
        if (error.type === 'entity.parse.failed') {
            return res.status(400).json({ error: 'JSON_INVALIDO', mensaje: 'El cuerpo de la petición no es JSON válido.' });
        }
        console.error('ERROR:', error.message);
        res.status(500).json({ error: 'ERROR_INTERNO', mensaje: 'Error interno del servidor.' });
    });

    return app;
}

module.exports = { crearApp };
