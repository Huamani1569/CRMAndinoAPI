// Endpoints de COTIZACIONES (HU-V03 y HU-P03)
//   GET  /api/cotizaciones                 vendedor: las suyas · cliente: las de su empresa · supervisor: todas
//   GET  /api/cotizaciones/:id
//   POST /api/cotizaciones                 vendedor: crear (y enviar) · total calculado por la base
//   POST /api/cotizaciones/:id/envio       vendedor: enviar un borrador
//   PUT  /api/cotizaciones/:id/respuesta   cliente: aceptar o rechazar (con motivo)
//   PUT  /api/cotizaciones/:id/aprobacion  supervisor: aprobar u observar un descuento mayor a 10 %
const express = require('express');
const { query } = require('../db');
const { permitirRoles } = require('../middleware/auth');
const { ejecutarOperacion } = require('../operaciones');
const { ErrorHttp, ROL_VENDEDOR, ROL_SUPERVISOR, ROL_CLIENTE, esUuid } = require('../errores');
const { notificar, usuariosDeCliente, supervisores, siguienteNumero } = require('../servicios');

const router = express.Router();
router.param('id', (req, res, next, id) => {
    if (!/^\d+$/.test(id)) return res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Identificador no válido.' });
    next();
});

const DESCUENTO_MAX_VENDEDOR = 10;   // RN-03
const VIGENCIA_DIAS = 15;            // RN-04
const MOTIVOS = ['PRECIO', 'PLAZO', 'OTRA_EMPRESA', 'OTRO'];

const SELECT_COT = `
    SELECT co.*, co.subtotal::float8 AS subtotal_n, co.total::float8 AS total_n, co.descuento_pct::float8 AS descuento_n,
           to_char(co.vigencia_hasta, 'YYYY-MM-DD') AS vigencia, (co.vigencia_hasta - CURRENT_DATE)::int AS dias_vencer,
           l.empresa, l.uuid AS lead_uuid, l.cliente_id, l.ruc AS lead_ruc, l.etapa AS lead_etapa,
           v.nombre AS vendedor_nombre, a.nombre AS aprobador_nombre,
           COALESCE((SELECT json_agg(json_build_object('productoId', d.producto_id, 'nombre', p.nombre, 'cantidad', d.cantidad,
                         'precioUnit', d.precio_unit::float8, 'subtotal', d.subtotal::float8) ORDER BY d.id)
                     FROM cotizacion_detalle d JOIN productos p ON p.id = d.producto_id WHERE d.cotizacion_id = co.id), '[]') AS items
    FROM cotizaciones co
    JOIN leads l ON l.id = co.lead_id
    JOIN usuarios v ON v.id = co.vendedor_id
    LEFT JOIN usuarios a ON a.id = co.aprobada_por`;

function aDto(f) {
    return {
        id: f.id, uuid: f.uuid, numero: f.numero, leadId: f.lead_id, leadUuid: f.lead_uuid, empresa: f.empresa,
        vendedorId: f.vendedor_id, vendedorNombre: f.vendedor_nombre, items: f.items,
        subtotal: f.subtotal_n, descuentoPct: f.descuento_n, total: f.total_n, estado: f.estado,
        vigenciaHasta: f.vigencia, diasParaVencer: f.estado === 'ENVIADA' ? f.dias_vencer : null,
        requiereAprobacion: f.descuento_n > DESCUENTO_MAX_VENDEDOR, aprobadaPor: f.aprobador_nombre,
        motivoRechazo: f.motivo_rechazo, comentarioRechazo: f.comentario_rechazo,
        enviadaEn: f.enviada_en, respondidaEn: f.respondida_en, version: f.version, actualizadoEn: f.actualizado_en
    };
}

// Condición: la cotización es de la empresa del cliente (por cuenta o por RUC)
const DE_CLIENTE = (p) => `(l.cliente_id = ${p} OR (l.ruc IS NOT NULL AND l.ruc = (SELECT ruc FROM clientes WHERE id = ${p})))`;

// RN-04: las cotizaciones enviadas que pasaron su vigencia quedan VENCIDAS
async function vencerCotizaciones(c = { query }) {
    await c.query(`UPDATE cotizaciones SET estado = 'VENCIDA', version = version + 1, actualizado_en = now()
                   WHERE estado = 'ENVIADA' AND vigencia_hasta < (now() AT TIME ZONE 'America/Lima')::date`);
}

async function buscar(c, id, bloquear = false) {
    const r = await c.query(`${SELECT_COT} WHERE co.id = $1 ${bloquear ? 'FOR UPDATE OF co' : ''}`, [id]);
    return r.rows[0];
}

function puedeVer(usuario, f) {
    if (usuario.rol === ROL_SUPERVISOR) return true;
    if (usuario.rol === ROL_VENDEDOR) return f.vendedor_id === usuario.id;
    return false;   // el cliente se valida con DE_CLIENTE en la consulta
}

// ---------------------------------------------------------------- consultas
router.get('/', async (req, res, next) => {
    try {
        await vencerCotizaciones();
        const cond = ['NOT co.eliminado'], par = [];
        const p = (v) => { par.push(v); return `$${par.length}`; };
        if (req.usuario.rol === ROL_VENDEDOR) cond.push(`co.vendedor_id = ${p(req.usuario.id)}`);
        else if (req.usuario.rol === ROL_CLIENTE) {
            cond.push(DE_CLIENTE(p(req.usuario.clienteId)));
            cond.push("co.estado NOT IN ('BORRADOR','PEND_APROBACION')");
        } else if (req.usuario.rol !== ROL_SUPERVISOR) return res.status(403).json({ error: 'SIN_PERMISO', mensaje: 'Tu rol no puede ver cotizaciones.' });
        if (req.query.estado) cond.push(`co.estado = ${p(String(req.query.estado))}`);
        if (req.query.leadId) cond.push(`co.lead_id = ${p(Number(req.query.leadId))}`);
        if (req.query.desde) cond.push(`co.actualizado_en > ${p(new Date(req.query.desde))}`);
        const r = await query(`${SELECT_COT} WHERE ${cond.join(' AND ')} ORDER BY co.creado_en DESC`, par);
        res.json({ servidorTiempo: new Date().toISOString(), total: r.rowCount, datos: r.rows.map(aDto) });
    } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
    try {
        await vencerCotizaciones();
        const par = [req.params.id];
        let extra = '';
        if (req.usuario.rol === ROL_CLIENTE) { par.push(req.usuario.clienteId); extra = ` AND ${DE_CLIENTE('$2')} AND co.estado NOT IN ('BORRADOR','PEND_APROBACION')`; }
        const r = await query(`${SELECT_COT} WHERE co.id = $1${extra}`, par);
        const f = r.rows[0];
        if (!f || (req.usuario.rol !== ROL_CLIENTE && !puedeVer(req.usuario, f))) {
            return res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Cotización no encontrada.' });
        }
        res.json({ dato: aDto(f) });
    } catch (e) { next(e); }
});

// ---------------------------------------------------------------- crear y enviar (vendedor)
async function enviar(c, cot, aprobadorId = null) {
    await c.query(`UPDATE cotizaciones SET estado = 'ENVIADA', enviada_en = now(), aprobada_por = COALESCE($2, aprobada_por),
                   vigencia_hasta = (now() AT TIME ZONE 'America/Lima')::date + ${VIGENCIA_DIAS}, version = version + 1, actualizado_en = now()
                   WHERE id = $1`, [cot.id, aprobadorId]);
    // El lead pasa a COTIZADO (RF-V10)
    await c.query(`UPDATE leads SET etapa = 'COTIZADO', version = version + 1, actualizado_en = now()
                   WHERE id = $1 AND etapa IN ('NUEVO','CONTACTADO','CALIFICADO')`, [cot.lead_id]);
    const cliente = cot.cliente_id || (cot.lead_ruc ? (await c.query('SELECT id FROM clientes WHERE ruc = $1', [cot.lead_ruc])).rows[0]?.id : null);
    if (cliente) {
        await notificar(c, await usuariosDeCliente(c, cliente), 'COTIZACION_RECIBIDA', 'Recibiste una cotización',
            `${cot.numero} · S/ ${Number(cot.total_n).toLocaleString('es-PE', { minimumFractionDigits: 2 })} · vence en ${VIGENCIA_DIAS} días`, 'cotizacion', cot.id);
    }
}

async function pedirAprobacion(c, cot) {
    await c.query(`UPDATE cotizaciones SET estado = 'PEND_APROBACION', version = version + 1, actualizado_en = now() WHERE id = $1`, [cot.id]);
    await notificar(c, await supervisores(c), 'APROBACION_PENDIENTE', `Descuento de ${cot.descuento_n} % por aprobar`,
        `${cot.numero} · ${cot.empresa} · ${cot.vendedor_nombre}`, 'cotizacion', cot.id);
}

router.post('/', permitirRoles(ROL_VENDEDOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'cotizacion', 'CREAR', async (c) => {
        const b = req.body;
        if (!esUuid(b.uuid)) throw new ErrorHttp(422, 'UUID_INVALIDO', 'La cotización debe tener un uuid válido.');
        const existente = await c.query('SELECT id FROM cotizaciones WHERE uuid = $1', [b.uuid]);
        if (existente.rowCount) return { status: 200, cuerpo: { dato: aDto(await buscar(c, existente.rows[0].id)) } };

        const lead = (await c.query(
            `SELECT id, vendedor_id, etapa, eliminado FROM leads WHERE ${b.leadUuid ? 'uuid = $1' : 'id = $1'} FOR UPDATE`,
            [b.leadUuid || Number(b.leadId)])).rows[0];
        if (!lead || lead.eliminado) throw new ErrorHttp(422, 'LEAD_NO_EXISTE', 'El lead no existe en el servidor (sincroniza primero el lead).');
        if (lead.vendedor_id !== req.usuario.id) throw new ErrorHttp(409, 'REASIGNADO', 'Este lead ya no está asignado a ti.');
        if (!['NUEVO', 'CONTACTADO', 'CALIFICADO'].includes(lead.etapa)) {
            throw new ErrorHttp(422, 'ETAPA_NO_COTIZABLE', `Un lead en etapa ${lead.etapa} no se puede cotizar. Debe estar en CONTACTADO o CALIFICADO.`);
        }
        const descuento = Number(b.descuentoPct ?? 0);
        if (!Number.isFinite(descuento) || descuento < 0 || descuento > 50) throw new ErrorHttp(422, 'DESCUENTO_INVALIDO', 'El descuento debe estar entre 0 % y 50 %.');
        const items = (Array.isArray(b.items) ? b.items : []).map(i => ({ productoId: Number(i.productoId), cantidad: Math.floor(Number(i.cantidad)) }))
            .filter(i => Number.isInteger(i.productoId) && i.cantidad > 0);
        if (!items.length) throw new ErrorHttp(422, 'SIN_PRODUCTOS', 'Agrega al menos un producto con su cantidad.');

        const numero = await siguienteNumero(c, 'COT');
        const r = await c.query(
            `INSERT INTO cotizaciones (uuid, numero, lead_id, vendedor_id, descuento_pct) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [b.uuid, numero, lead.id, req.usuario.id, descuento]);
        const id = r.rows[0].id;
        for (const i of items) {
            const p = await c.query('SELECT precio FROM productos WHERE id = $1 AND activo', [i.productoId]);
            if (!p.rowCount) throw new ErrorHttp(422, 'PRODUCTO_INVALIDO', 'Uno de los productos no existe.');
            await c.query(`INSERT INTO cotizacion_detalle (cotizacion_id, producto_id, cantidad, precio_unit) VALUES ($1, $2, $3, $4)
                           ON CONFLICT (cotizacion_id, producto_id) DO UPDATE SET cantidad = cotizacion_detalle.cantidad + EXCLUDED.cantidad`,
                [id, i.productoId, i.cantidad, p.rows[0].precio]);
        }
        if (b.enviar === true) {
            const cot = await buscar(c, id);
            if (descuento > DESCUENTO_MAX_VENDEDOR) await pedirAprobacion(c, cot);
            else await enviar(c, cot);
        }
        return { status: 201, cuerpo: { dato: aDto(await buscar(c, id)) } };
    })
);

router.post('/:id/envio', permitirRoles(ROL_VENDEDOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'cotizacion', 'ENVIAR', async (c) => {
        const cot = await buscar(c, req.params.id, true);
        if (!cot || cot.vendedor_id !== req.usuario.id) throw new ErrorHttp(404, 'NO_ENCONTRADO', 'Cotización no encontrada.');
        if (cot.estado !== 'BORRADOR') throw new ErrorHttp(409, 'YA_ENVIADA', `La cotización ya está ${cot.estado}.`, { actual: aDto(cot) });
        if (cot.descuento_n > DESCUENTO_MAX_VENDEDOR) await pedirAprobacion(c, cot);
        else await enviar(c, cot);
        return { status: 200, cuerpo: { dato: aDto(await buscar(c, cot.id)) } };
    })
);

// ---------------------------------------------------------------- respuesta del cliente
router.put('/:id/respuesta', permitirRoles(ROL_CLIENTE), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'cotizacion', 'RESPONDER', async (c) => {
        await vencerCotizaciones(c);
        const r = await c.query(`${SELECT_COT} WHERE co.id = $1 AND ${DE_CLIENTE('$2')} FOR UPDATE OF co`, [req.params.id, req.usuario.clienteId]);
        const cot = r.rows[0];
        if (!cot || ['BORRADOR', 'PEND_APROBACION'].includes(cot.estado)) throw new ErrorHttp(404, 'NO_ENCONTRADO', 'Cotización no encontrada.');
        if (cot.estado === 'VENCIDA') throw new ErrorHttp(409, 'COTIZACION_VENCIDA', 'Esta cotización venció y ya no se puede aceptar. Puedes pedir una nueva.', { actual: aDto(cot) });
        if (cot.estado !== 'ENVIADA') throw new ErrorHttp(409, 'YA_RESPONDIDA', `Esta cotización ya fue ${cot.estado.toLowerCase()}.`, { actual: aDto(cot) });

        const decision = String(req.body.decision || '').toUpperCase();
        if (decision === 'ACEPTAR') {
            await c.query(`UPDATE cotizaciones SET estado = 'ACEPTADA', respondida_en = now(), version = version + 1, actualizado_en = now() WHERE id = $1`, [cot.id]);
            // RN-05: el lead pasa a GANADO y queda vinculado a la cuenta del cliente
            await c.query(`UPDATE leads SET etapa = 'GANADO', cliente_id = $2, version = version + 1, actualizado_en = now() WHERE id = $1`,
                [cot.lead_id, req.usuario.clienteId]);
            await c.query('UPDATE clientes SET vendedor_id = COALESCE(vendedor_id, $2) WHERE id = $1', [req.usuario.clienteId, cot.vendedor_id]);
            await notificar(c, cot.vendedor_id, 'COTIZACION_ACEPTADA', '¡Cotización aceptada!',
                `${cot.empresa} aceptó ${cot.numero} por S/ ${cot.total_n.toLocaleString('es-PE', { minimumFractionDigits: 2 })}`, 'cotizacion', cot.id);
        } else if (decision === 'RECHAZAR') {
            const motivo = String(req.body.motivo || '').toUpperCase();
            if (!MOTIVOS.includes(motivo)) throw new ErrorHttp(422, 'MOTIVO_OBLIGATORIO', 'Elige el motivo del rechazo: precio, plazo, otra empresa u otro.');
            await c.query(`UPDATE cotizaciones SET estado = 'RECHAZADA', motivo_rechazo = $2, comentario_rechazo = $3, respondida_en = now(),
                           version = version + 1, actualizado_en = now() WHERE id = $1`,
                [cot.id, motivo, String(req.body.comentario || '').trim().slice(0, 300) || null]);
            // El lead vuelve a CALIFICADO para que el vendedor pueda recotizar
            await c.query(`UPDATE leads SET etapa = 'CALIFICADO', version = version + 1, actualizado_en = now() WHERE id = $1 AND etapa = 'COTIZADO'`, [cot.lead_id]);
            const motivoTxt = { PRECIO: 'el precio', PLAZO: 'el plazo', OTRA_EMPRESA: 'eligió otra empresa', OTRO: 'otro motivo' }[motivo];
            await notificar(c, cot.vendedor_id, 'COTIZACION_RECHAZADA', 'Cotización rechazada', `${cot.empresa} rechazó ${cot.numero} por ${motivoTxt}`, 'cotizacion', cot.id);
        } else {
            throw new ErrorHttp(422, 'DECISION_INVALIDA', 'La decisión debe ser ACEPTAR o RECHAZAR.');
        }
        return { status: 200, cuerpo: { dato: aDto(await buscar(c, cot.id)) } };
    })
);

// ---------------------------------------------------------------- aprobación del supervisor (RN-03)
router.put('/:id/aprobacion', permitirRoles(ROL_SUPERVISOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'cotizacion', 'APROBAR', async (c) => {
        const cot = await buscar(c, req.params.id, true);
        if (!cot) throw new ErrorHttp(404, 'NO_ENCONTRADO', 'Cotización no encontrada.');
        if (cot.estado !== 'PEND_APROBACION') throw new ErrorHttp(409, 'NO_PENDIENTE', `La cotización está ${cot.estado}, no pendiente de aprobación.`, { actual: aDto(cot) });
        if (req.body.aprobar === true) {
            await enviar(c, cot, req.usuario.id);
            await notificar(c, cot.vendedor_id, 'DESCUENTO_APROBADO', 'Descuento aprobado', `${cot.numero} ya fue enviada a ${cot.empresa}`, 'cotizacion', cot.id);
        } else {
            await c.query(`UPDATE cotizaciones SET estado = 'BORRADOR', version = version + 1, actualizado_en = now() WHERE id = $1`, [cot.id]);
            const obs = String(req.body.observacion || '').trim();
            await notificar(c, cot.vendedor_id, 'DESCUENTO_OBSERVADO', 'Descuento observado', `${cot.numero}${obs ? ': ' + obs : ': revisa el descuento'}`, 'cotizacion', cot.id);
        }
        return { status: 200, cuerpo: { dato: aDto(await buscar(c, cot.id)) } };
    })
);

module.exports = router;
module.exports.vencerCotizaciones = vencerCotizaciones;
