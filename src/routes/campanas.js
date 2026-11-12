// Endpoints de CAMPAÑAS DE MARKETING (HU-S04, HU-P05 · Laudon fig. 9.7)
//   GET  /api/campanas                    supervisor: campañas con sus resultados resumidos
//   POST /api/campanas/previsualizar      supervisor: cuántos clientes recibirán la campaña (sin crearla)
//   POST /api/campanas                    supervisor: crear en BORRADOR
//   POST /api/campanas/:id/envio          supervisor: enviar (un envío por cliente y canal; push al Portal)
//   GET  /api/campanas/:id/resultados     supervisor: respuestas por canal y conversión (RF-S08)
//   POST /api/campanas/:id/respuesta      cliente: "Me interesa" → lead con canal CAMPANA (RF-P10)
const express = require('express');
const { query } = require('../db');
const { permitirRoles } = require('../middleware/auth');
const { ejecutarOperacion } = require('../operaciones');
const { ErrorHttp, ROL_SUPERVISOR, ROL_CLIENTE, esFechaIso, hoyLima } = require('../errores');
const { notificar, usuariosDeCliente, elegirVendedor } = require('../servicios');
const { puntuarLead } = require('../ml');

const router = express.Router();
router.param('id', (req, res, next, id) => {
    if (!/^\d+$/.test(id)) return res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Identificador no válido.' });
    next();
});

const CANALES = ['PUSH', 'WHATSAPP', 'CORREO', 'LLAMADA', 'VISITA'];

// Filtro del segmento → SQL sobre clientes (RN-07: solo clientes activos que aceptan ofertas)
function sqlSegmento(seg = {}, par) {
    const p = (v) => { par.push(v); return `$${par.length}`; };
    const cond = ['c.acepta_ofertas', 'c.cancelado_en IS NULL'];
    const compro = (codigo) => `EXISTS (SELECT 1 FROM leads l JOIN cotizaciones co ON co.lead_id = l.id AND co.estado = 'ACEPTADA'
        JOIN cotizacion_detalle d ON d.cotizacion_id = co.id JOIN productos pr ON pr.id = d.producto_id
        WHERE l.cliente_id = c.id AND pr.codigo = ${p(codigo)})`;
    if (seg.segmento) cond.push(`c.segmento = ${p(String(seg.segmento))}`);
    if (seg.distrito) cond.push(`c.distrito = ${p(String(seg.distrito))}`);
    if (seg.tieneProducto) cond.push(compro(String(seg.tieneProducto)));
    if (seg.sinProducto) cond.push(`NOT ${compro(String(seg.sinProducto))}`);
    if (seg.puntajeValorMin != null) cond.push(`c.puntaje_valor >= ${p(Number(seg.puntajeValorMin))}`);
    if (seg.riesgoMin != null) cond.push(`c.prob_cancelacion >= ${p(Number(seg.riesgoMin))}`);
    return `SELECT c.id FROM clientes c WHERE ${cond.join(' AND ')}`;
}

async function tamanoSegmento(seg) {
    const par = [];
    const r = await query(`SELECT count(*)::int AS n FROM (${sqlSegmento(seg, par)}) x`, par);
    const excl = await query('SELECT count(*)::int AS n FROM clientes WHERE NOT acepta_ofertas AND cancelado_en IS NULL');
    return { clientes: r.rows[0].n, excluidosSinOfertas: excl.rows[0].n };
}

const SELECT_CAMP = `
    SELECT ca.*, p.nombre AS producto, p.codigo AS producto_codigo, u.nombre AS creada_por_nombre,
           (SELECT count(DISTINCT cliente_id) FROM respuestas_campana r WHERE r.campana_id = ca.id)::int AS alcanzados,
           (SELECT count(*) FROM respuestas_campana r WHERE r.campana_id = ca.id)::int AS envios,
           (SELECT count(*) FROM respuestas_campana r WHERE r.campana_id = ca.id AND r.respondio)::int AS respuestas,
           (SELECT count(*) FROM leads l WHERE l.campana_id = ca.id)::int AS leads,
           (SELECT count(*) FROM leads l WHERE l.campana_id = ca.id AND l.etapa = 'GANADO')::int AS ganados
    FROM campanas ca LEFT JOIN productos p ON p.id = ca.producto_id JOIN usuarios u ON u.id = ca.creada_por`;

const aDto = (f) => ({
    id: f.id, nombre: f.nombre, segmento: f.segmento, oferta: f.oferta, productoId: f.producto_id, producto: f.producto,
    descuentoPct: Number(f.descuento_pct), canales: f.canales, inicio: f.inicio, fin: f.fin, estado: f.estado,
    creadaPor: f.creada_por_nombre, alcanzados: f.alcanzados, envios: f.envios, respuestas: f.respuestas,
    tasaRespuesta: f.envios ? Math.round(1000 * f.respuestas / f.envios) / 10 : 0,
    leadsGenerados: f.leads, ganados: f.ganados, conversion: f.leads ? Math.round(1000 * f.ganados / f.leads) / 10 : 0
});

function validar(b) {
    const nombre = String(b.nombre || '').trim(), oferta = String(b.oferta || '').trim();
    const canales = (Array.isArray(b.canales) ? b.canales : []).map(x => String(x).toUpperCase());
    if (!nombre) throw new ErrorHttp(422, 'NOMBRE_OBLIGATORIO', 'Escribe el nombre de la campaña.');
    if (!oferta) throw new ErrorHttp(422, 'OFERTA_OBLIGATORIA', 'Describe la oferta.');
    if (!canales.length || canales.some(x => !CANALES.includes(x))) throw new ErrorHttp(422, 'CANALES_INVALIDOS', `Elige uno o más canales: ${CANALES.join(', ')}.`);
    if (!esFechaIso(b.inicio) || !esFechaIso(b.fin)) throw new ErrorHttp(422, 'FECHAS_INVALIDAS', 'Indica las fechas de inicio y fin (AAAA-MM-DD).');
    if (b.fin < b.inicio) throw new ErrorHttp(422, 'FECHAS_INVALIDAS', 'La fecha de fin no puede ser anterior al inicio.');
    if (b.fin < hoyLima()) throw new ErrorHttp(422, 'FECHAS_INVALIDAS', 'La campaña ya habría terminado.');
    const d = Number(b.descuentoPct ?? 0);
    if (!Number.isFinite(d) || d < 0 || d > 50) throw new ErrorHttp(422, 'DESCUENTO_INVALIDO', 'El descuento debe estar entre 0 % y 50 %.');
    return { nombre, oferta, canales: [...new Set(canales)], descuento: d, segmento: b.segmento && typeof b.segmento === 'object' ? b.segmento : {} };
}

// ---------------------------------------------------------------- supervisor
router.get('/', permitirRoles(ROL_SUPERVISOR), async (req, res, next) => {
    try {
        const r = await query(`${SELECT_CAMP} ORDER BY ca.inicio DESC, ca.id DESC`);
        res.json({ servidorTiempo: new Date().toISOString(), total: r.rowCount, datos: r.rows.map(aDto) });
    } catch (e) { next(e); }
});

router.post('/previsualizar', permitirRoles(ROL_SUPERVISOR), async (req, res, next) => {
    try { res.json(await tamanoSegmento(req.body?.segmento || req.body || {})); } catch (e) { next(e); }
});

router.post('/', permitirRoles(ROL_SUPERVISOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'campana', 'CREAR', async (c) => {
        const d = validar(req.body);
        let productoId = null;
        if (req.body.productoId) {
            const p = await c.query('SELECT id FROM productos WHERE id = $1', [Number(req.body.productoId)]);
            if (!p.rowCount) throw new ErrorHttp(422, 'PRODUCTO_INVALIDO', 'El producto no existe.');
            productoId = p.rows[0].id;
        }
        const r = await c.query(`INSERT INTO campanas (nombre, segmento, oferta, producto_id, descuento_pct, canales, inicio, fin, creada_por)
                                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [d.nombre, JSON.stringify(d.segmento), d.oferta, productoId, d.descuento, d.canales, req.body.inicio, req.body.fin, req.usuario.id]);
        const f = (await c.query(`${SELECT_CAMP} WHERE ca.id = $1`, [r.rows[0].id])).rows[0];
        return { status: 201, cuerpo: { dato: { ...aDto(f), tamanoSegmento: (await tamanoSegmento(d.segmento)).clientes } } };
    })
);

router.post('/:id/envio', permitirRoles(ROL_SUPERVISOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'campana', 'ENVIAR', async (c) => {
        const ca = (await c.query('SELECT * FROM campanas WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
        if (!ca) throw new ErrorHttp(404, 'NO_ENCONTRADO', 'Campaña no encontrada.');
        if (ca.estado !== 'BORRADOR') throw new ErrorHttp(409, 'YA_ENVIADA', 'Esta campaña ya fue enviada.');
        const par = [];
        const clientes = (await c.query(sqlSegmento(ca.segmento, par), par)).rows.map(x => x.id);
        let envios = 0;
        for (const cli of clientes) {
            for (const canal of ca.canales) {
                const r = await c.query(`INSERT INTO respuestas_campana (campana_id, cliente_id, canal) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [ca.id, cli, canal]);
                envios += r.rowCount;
            }
            if (ca.canales.includes('PUSH')) {
                await notificar(c, await usuariosDeCliente(c, cli), 'OFERTA', 'Oferta para ti', ca.oferta, 'campana', ca.id);
            }
        }
        await c.query("UPDATE campanas SET estado = 'ENVIADA' WHERE id = $1", [ca.id]);
        return { status: 200, cuerpo: { clientes: clientes.length, envios } };
    })
);

router.get('/:id/resultados', permitirRoles(ROL_SUPERVISOR), async (req, res, next) => {
    try {
        const f = (await query(`${SELECT_CAMP} WHERE ca.id = $1`, [req.params.id])).rows[0];
        if (!f) return res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Campaña no encontrada.' });
        const porCanal = await query(`
            SELECT canal, count(*)::int AS enviados, count(*) FILTER (WHERE respondio)::int AS respuestas
            FROM respuestas_campana WHERE campana_id = $1 GROUP BY canal ORDER BY respuestas DESC`, [f.id]);
        res.json({
            dato: aDto(f),
            porCanal: porCanal.rows.map(x => ({ ...x, tasaRespuesta: x.enviados ? Math.round(1000 * x.respuestas / x.enviados) / 10 : 0 }))
        });
    } catch (e) { next(e); }
});

// ---------------------------------------------------------------- cliente: "Me interesa"
router.post('/:id/respuesta', permitirRoles(ROL_CLIENTE), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'campana', 'RESPONDER', async (c) => {
        const canal = String(req.body.canal || 'PUSH').toUpperCase();
        if (!CANALES.includes(canal)) throw new ErrorHttp(422, 'CANAL_INVALIDO', 'Canal no válido.');
        const ca = (await c.query(`SELECT ca.*, p.nombre AS producto, p.precio FROM campanas ca LEFT JOIN productos p ON p.id = ca.producto_id
                                   WHERE ca.id = $1`, [req.params.id])).rows[0];
        if (!ca || ca.estado !== 'ENVIADA') throw new ErrorHttp(404, 'NO_ENCONTRADO', 'La oferta ya no está disponible.');
        const cli = (await c.query('SELECT * FROM clientes WHERE id = $1', [req.usuario.clienteId])).rows[0];
        if (!cli.acepta_ofertas) throw new ErrorHttp(409, 'OFERTAS_DESACTIVADAS', 'Desactivaste las ofertas en tu perfil.');
        const envio = await c.query('SELECT id, respondio, lead_id FROM respuestas_campana WHERE campana_id = $1 AND cliente_id = $2 ORDER BY (canal = $3) DESC LIMIT 1',
            [ca.id, cli.id, canal]);
        if (!envio.rowCount) throw new ErrorHttp(404, 'NO_ENCONTRADO', 'Esta oferta no fue enviada a tu empresa.');
        const ya = await c.query('SELECT lead_id FROM respuestas_campana WHERE campana_id = $1 AND cliente_id = $2 AND respondio LIMIT 1', [ca.id, cli.id]);
        if (ya.rowCount) return { status: 200, cuerpo: { leadId: ya.rows[0].lead_id, mensaje: 'Ya registramos tu interés. Tu asesor te contactará pronto.' } };

        const u = (await c.query('SELECT nombre, telefono, correo FROM usuarios WHERE id = $1', [req.usuario.id])).rows[0];
        const vendedor = await elegirVendedor(c, cli.id);
        const lead = await c.query(
            `INSERT INTO leads (uuid, empresa, contacto, telefono, correo, ruc, valor_potencial, etapa, vendedor_id, canal_origen, campana_id,
                                cliente_id, comentario_cliente, latitud, longitud, direccion)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'NUEVO', $7, 'CAMPANA', $8, $9, $10, $11, $12, $13) RETURNING id`,
            [cli.razon_social, u.nombre, u.telefono, u.correo, cli.ruc, Number(ca.precio || 0) * (1 - Number(ca.descuento_pct) / 100),
                vendedor, ca.id, cli.id, `Me interesa: ${ca.oferta}`, cli.latitud, cli.longitud, cli.direccion]);
        await c.query(`UPDATE respuestas_campana SET respondio = TRUE, respondido_en = now(), lead_id = $2 WHERE id = $1`, [envio.rows[0].id, lead.rows[0].id]);
        const puntaje = await puntuarLead(c, lead.rows[0].id);
        await notificar(c, vendedor, 'LEAD_CAMPANA', 'Cliente interesado en una campaña',
            `${cli.razon_social} · ${ca.nombre}${puntaje != null ? ` · ${puntaje} pts` : ''}`, 'lead', lead.rows[0].id);
        return { status: 201, cuerpo: { leadId: lead.rows[0].id, mensaje: 'Tu asesor te contactará pronto.' } };
    })
);

module.exports = router;
