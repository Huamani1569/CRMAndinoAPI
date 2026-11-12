// Endpoints de CLIENTES y RECOMENDACIONES
//   GET /api/clientes                       supervisor/agente: clientes con puntajes (filtros) · vendedor: sus cuentas
//   GET /api/clientes/:id                   ficha: historial de compras, puntajes y factores (RF-V15, RF-S05)
//   GET /api/ml/recomendaciones/:clienteId  hasta 3 productos de venta cruzada con su justificación (RF-V16)
const express = require('express');
const { query } = require('../db');
const { ROL_VENDEDOR, ROL_CLIENTE } = require('../errores');
const { num } = require('../servicios');

const router = express.Router();

const SELECT_CLI = `
    SELECT c.id, c.ruc, c.razon_social, c.distrito, c.segmento, c.fecha_alta, c.puntaje_valor, c.prob_cancelacion::float8 AS prob,
           c.factores_riesgo, c.cltv::float8 AS cltv, c.acepta_ofertas, c.cancelado_en, c.vendedor_id, v.nombre AS vendedor,
           c.latitud::float8 AS lat, c.longitud::float8 AS lon,
           (SELECT count(*) FROM cotizaciones co JOIN leads l ON l.id = co.lead_id WHERE l.cliente_id = c.id AND co.estado = 'ACEPTADA')::int AS compras,
           (SELECT COALESCE(sum(co.total), 0) FROM cotizaciones co JOIN leads l ON l.id = co.lead_id WHERE l.cliente_id = c.id AND co.estado = 'ACEPTADA')::float8 AS monto,
           (SELECT max(co.respondida_en) FROM cotizaciones co JOIN leads l ON l.id = co.lead_id WHERE l.cliente_id = c.id AND co.estado = 'ACEPTADA') AS ultima_compra,
           (SELECT count(*) FROM solicitudes_servicio s WHERE s.cliente_id = c.id)::int AS tickets,
           (SELECT avg(s.calificacion) FROM solicitudes_servicio s WHERE s.cliente_id = c.id)::float8 AS csat
    FROM clientes c LEFT JOIN usuarios v ON v.id = c.vendedor_id`;

const aDto = (f) => ({
    id: f.id, ruc: f.ruc.trim(), razonSocial: f.razon_social, distrito: f.distrito, segmento: f.segmento, clienteDesde: f.fecha_alta,
    vendedorId: f.vendedor_id, vendedorNombre: f.vendedor, puntajeValor: f.puntaje_valor, probCancelacion: num(f.prob),
    factoresRiesgo: f.factores_riesgo || [], cltv: num(f.cltv), aceptaOfertas: f.acepta_ofertas, canceladoEn: f.cancelado_en,
    latitud: num(f.lat), longitud: num(f.lon), compras: f.compras, comprasTotal: f.monto, ultimaCompra: f.ultima_compra,
    ticketsPrevios: f.tickets, csatPromedio: f.csat == null ? null : Math.round(f.csat * 10) / 10
});

router.get('/clientes', async (req, res, next) => {
    try {
        if (req.usuario.rol === ROL_CLIENTE) return res.status(403).json({ error: 'SIN_PERMISO', mensaje: 'Tu rol no puede ver clientes.' });
        const cond = ['TRUE'], par = [];
        const p = (v) => { par.push(v); return `$${par.length}`; };
        if (req.usuario.rol === ROL_VENDEDOR) cond.push(`c.vendedor_id = ${p(req.usuario.id)}`);
        if (req.query.activos !== '0') cond.push('c.cancelado_en IS NULL');
        if (req.query.buscar) cond.push(`(c.razon_social ILIKE ${p('%' + req.query.buscar + '%')} OR c.ruc LIKE ${p(req.query.buscar + '%')})`);
        const r = await query(`${SELECT_CLI} WHERE ${cond.join(' AND ')} ORDER BY c.puntaje_valor DESC NULLS LAST, c.razon_social LIMIT 300`, par);
        res.json({ servidorTiempo: new Date().toISOString(), total: r.rowCount, datos: r.rows.map(aDto) });
    } catch (e) { next(e); }
});

router.get('/clientes/:id', async (req, res, next) => {
    try {
        if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Identificador no válido.' });
        const f = (await query(`${SELECT_CLI} WHERE c.id = $1`, [req.params.id])).rows[0];
        const prohibido = !f || req.usuario.rol === ROL_CLIENTE ||
            (req.usuario.rol === ROL_VENDEDOR && f.vendedor_id !== req.usuario.id &&
                !(await query('SELECT 1 FROM leads WHERE cliente_id = $1 AND vendedor_id = $2 LIMIT 1', [f?.id, req.usuario.id])).rowCount);
        if (prohibido) return res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Cliente no encontrado.' });
        const compras = await query(`
            SELECT co.id, co.numero, co.respondida_en AS fecha, p.nombre AS producto, d.cantidad, d.subtotal::float8 AS monto
            FROM cotizaciones co JOIN leads l ON l.id = co.lead_id JOIN cotizacion_detalle d ON d.cotizacion_id = co.id
            JOIN productos p ON p.id = d.producto_id
            WHERE l.cliente_id = $1 AND co.estado = 'ACEPTADA' ORDER BY co.respondida_en DESC, d.id`, [f.id]);
        res.json({ dato: { ...aDto(f), historialCompras: compras.rows } });
    } catch (e) { next(e); }
});

router.get('/ml/recomendaciones/:clienteId', async (req, res, next) => {
    try {
        if (req.usuario.rol === ROL_CLIENTE && Number(req.params.clienteId) !== req.usuario.clienteId) {
            return res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Cliente no encontrado.' });
        }
        const r = await query(`
            SELECT r.producto_id, p.nombre, p.precio::float8 AS precio, r.confianza::float8 AS confianza, r.lift::float8 AS lift, r.razon
            FROM recomendaciones r JOIN productos p ON p.id = r.producto_id
            WHERE r.cliente_id = $1 ORDER BY r.confianza DESC LIMIT 3`, [Number(req.params.clienteId)]);
        res.json({ total: r.rowCount, datos: r.rows.map(x => ({ productoId: x.producto_id, producto: x.nombre, precio: x.precio, confianza: x.confianza, lift: x.lift, razon: x.razon })) });
    } catch (e) { next(e); }
});

module.exports = router;
