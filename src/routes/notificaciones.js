// Bandeja de NOTIFICACIONES y SINCRONIZACIÓN liviana
//   GET /api/notificaciones?desde=      notificaciones del usuario (las apps las muestran como notificación del sistema)
//   PUT /api/notificaciones/leidas      marca como leídas (todas o hasta un id)
//   PUT /api/dispositivos               guarda el token de Firebase Cloud Messaging (para push real)
//   GET /api/sync/cambios?desde=        qué entidades cambiaron desde la última sincronización (la app descarga solo esas)
const express = require('express');
const { query } = require('../db');
const { ErrorHttp, ROL_VENDEDOR, ROL_CLIENTE, ROL_AGENTE } = require('../errores');

const router = express.Router();

router.get('/notificaciones', async (req, res, next) => {
    try {
        const par = [req.usuario.id];
        let filtro = '';
        if (req.query.desde) { par.push(new Date(req.query.desde)); filtro = ' AND creado_en > $2'; }
        const r = await query(`SELECT id, tipo, titulo, cuerpo, ref_tipo, ref_id, leida, creado_en FROM notificaciones
                               WHERE usuario_id = $1${filtro} ORDER BY id DESC LIMIT 100`, par);
        const noLeidas = await query('SELECT count(*)::int AS n FROM notificaciones WHERE usuario_id = $1 AND NOT leida', [req.usuario.id]);
        res.json({
            servidorTiempo: new Date().toISOString(), total: r.rowCount, noLeidas: noLeidas.rows[0].n,
            datos: r.rows.map(f => ({ id: Number(f.id), tipo: f.tipo, titulo: f.titulo, cuerpo: f.cuerpo, refTipo: f.ref_tipo, refId: f.ref_id, leida: f.leida, creadoEn: f.creado_en }))
        });
    } catch (e) { next(e); }
});

router.put('/notificaciones/leidas', async (req, res, next) => {
    try {
        const hasta = Number(req.body?.hastaId) || Number.MAX_SAFE_INTEGER;
        const r = await query('UPDATE notificaciones SET leida = TRUE WHERE usuario_id = $1 AND id <= $2 AND NOT leida', [req.usuario.id, hasta]);
        res.json({ marcadas: r.rowCount });
    } catch (e) { next(e); }
});

router.put('/dispositivos', async (req, res, next) => {
    try {
        const token = String(req.body?.tokenFcm || '').trim();
        const app = String(req.body?.app || '').toUpperCase();
        if (!token || !['VENDEDOR', 'PORTAL', 'SUPERVISOR'].includes(app)) throw new ErrorHttp(422, 'DATOS_INVALIDOS', 'Envía tokenFcm y app (VENDEDOR, PORTAL o SUPERVISOR).');
        await query(`INSERT INTO dispositivos (token_fcm, usuario_id, app) VALUES ($1, $2, $3)
                     ON CONFLICT (token_fcm) DO UPDATE SET usuario_id = $2, app = $3, actualizado_en = now()`, [token, req.usuario.id, app]);
        res.status(204).end();
    } catch (e) {
        if (e instanceof ErrorHttp) return res.status(e.status).json(e.cuerpo());
        next(e);
    }
});

router.get('/sync/cambios', async (req, res, next) => {
    try {
        const desde = req.query.desde ? new Date(req.query.desde) : new Date(0);
        const u = req.usuario;
        const cuenta = async (sql, par) => (await query(`SELECT count(*)::int AS n FROM (${sql}) x`, par)).rows[0].n;
        const cambios = {};
        if (u.rol === ROL_VENDEDOR) {
            cambios.leads = await cuenta('SELECT 1 FROM leads WHERE vendedor_id = $1 AND actualizado_en > $2', [u.id, desde]);
            cambios.cotizaciones = await cuenta('SELECT 1 FROM cotizaciones WHERE vendedor_id = $1 AND actualizado_en > $2', [u.id, desde]);
            cambios.tareas = await cuenta(`SELECT 1 FROM tareas t JOIN leads l ON l.id = t.lead_id
                                           WHERE COALESCE(t.asignada_a, l.vendedor_id) = $1 AND t.actualizado_en > $2`, [u.id, desde]);
            cambios.visitas = await cuenta('SELECT 1 FROM visitas WHERE vendedor_id = $1 AND actualizado_en > $2', [u.id, desde]);
        } else if (u.rol === ROL_CLIENTE) {
            cambios.solicitudesCotizacion = await cuenta(`SELECT 1 FROM leads WHERE cliente_id = $1 AND canal_origen = 'PORTAL' AND actualizado_en > $2`, [u.clienteId, desde]);
            cambios.cotizaciones = await cuenta(`SELECT 1 FROM cotizaciones co JOIN leads l ON l.id = co.lead_id
                                                 WHERE l.cliente_id = $1 AND co.actualizado_en > $2`, [u.clienteId, desde]);
            cambios.solicitudesServicio = await cuenta('SELECT 1 FROM solicitudes_servicio WHERE cliente_id = $1 AND actualizado_en > $2', [u.clienteId, desde]);
        } else {
            cambios.solicitudesServicio = await cuenta('SELECT 1 FROM solicitudes_servicio WHERE actualizado_en > $1', [desde]);
            if (u.rol !== ROL_AGENTE) {
                cambios.leads = await cuenta('SELECT 1 FROM leads WHERE actualizado_en > $1', [desde]);
                cambios.cotizaciones = await cuenta('SELECT 1 FROM cotizaciones WHERE actualizado_en > $1', [desde]);
            }
        }
        cambios.notificaciones = await cuenta('SELECT 1 FROM notificaciones WHERE usuario_id = $1 AND creado_en > $2', [u.id, desde]);
        res.json({ servidorTiempo: new Date().toISOString(), desde: desde.toISOString(), cambios });
    } catch (e) { next(e); }
});

module.exports = router;
