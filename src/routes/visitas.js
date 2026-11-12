// Endpoints de VISITAS EN CAMPO (HU-V04)
//   GET  /api/visitas/ruta?fecha=AAAA-MM-DD   ruta del día (programadas o, si no hay, sugeridas por puntaje)
//   GET  /api/visitas?fecha=&desde=           visitas del vendedor · supervisor: actividad del equipo
//   POST /api/visitas                         programar o hacer check-in con GPS (RF-V12, RF-V13)
const express = require('express');
const { query } = require('../db');
const { permitirRoles } = require('../middleware/auth');
const { ejecutarOperacion } = require('../operaciones');
const { ErrorHttp, ROL_VENDEDOR, ROL_SUPERVISOR, esUuid, esFechaIso, esFechaHoraIso, hoyLima } = require('../errores');
const { distanciaMetros, num } = require('../servicios');
const { puntuarLead } = require('../ml');

const router = express.Router();
const RADIO_MAXIMO_M = 300;

const SELECT_VISITA = `
    SELECT v.id, v.uuid, v.lead_id, l.uuid AS lead_uuid, l.empresa, l.contacto, l.telefono, l.direccion, l.puntaje, l.etapa,
           COALESCE(l.latitud, c.latitud)::float8 AS lat_cliente, COALESCE(l.longitud, c.longitud)::float8 AS lon_cliente,
           to_char(v.fecha_programada, 'YYYY-MM-DD') AS fecha_programada, v.checkin_en, v.latitud::float8 AS lat, v.longitud::float8 AS lon,
           v.precision_m::float8 AS precision_m, v.distancia_m::float8 AS distancia_m, v.motivo_distancia, v.vendedor_id,
           u.nombre AS vendedor_nombre, v.version, v.actualizado_en
    FROM visitas v JOIN leads l ON l.id = v.lead_id LEFT JOIN clientes c ON c.id = l.cliente_id JOIN usuarios u ON u.id = v.vendedor_id`;

const aDto = (f) => ({
    id: f.id, uuid: f.uuid, leadId: f.lead_id, leadUuid: f.lead_uuid, empresa: f.empresa, contacto: f.contacto, telefono: f.telefono,
    direccion: f.direccion, puntaje: f.puntaje, etapa: f.etapa, latitudCliente: num(f.lat_cliente), longitudCliente: num(f.lon_cliente),
    fechaProgramada: f.fecha_programada, checkinEn: f.checkin_en, latitud: num(f.lat), longitud: num(f.lon), precisionM: num(f.precision_m),
    distanciaM: num(f.distancia_m), motivoDistancia: f.motivo_distancia, vendedorId: f.vendedor_id, vendedorNombre: f.vendedor_nombre,
    sugerida: false, version: f.version, actualizadoEn: f.actualizado_en
});

router.get('/ruta', permitirRoles(ROL_VENDEDOR, ROL_SUPERVISOR), async (req, res, next) => {
    try {
        const fecha = esFechaIso(req.query.fecha) ? req.query.fecha : hoyLima();
        const vendedor = req.usuario.rol === ROL_VENDEDOR ? req.usuario.id : Number(req.query.vendedorId);
        if (!vendedor) return res.status(422).json({ error: 'VENDEDOR_REQUERIDO', mensaje: 'Indica el vendedor.' });
        const r = await query(`${SELECT_VISITA} WHERE v.vendedor_id = $1 AND v.fecha_programada = $2 AND NOT v.eliminado
                               ORDER BY l.puntaje DESC NULLS LAST`, [vendedor, fecha]);
        let datos = r.rows.map(aDto);
        let sugerida = false;
        if (!datos.length && fecha >= hoyLima()) {
            // Sin visitas programadas: se sugieren los 6 leads abiertos con mejor puntaje que tienen ubicación
            sugerida = true;
            const s = await query(`
                SELECT l.id, l.uuid, l.empresa, l.contacto, l.telefono, l.direccion, l.puntaje, l.etapa,
                       COALESCE(l.latitud, c.latitud)::float8 AS lat, COALESCE(l.longitud, c.longitud)::float8 AS lon
                FROM leads l LEFT JOIN clientes c ON c.id = l.cliente_id
                WHERE l.vendedor_id = $1 AND NOT l.eliminado AND l.etapa IN ('NUEVO','CONTACTADO','CALIFICADO','COTIZADO')
                  AND COALESCE(l.latitud, c.latitud) IS NOT NULL
                ORDER BY l.puntaje DESC NULLS LAST, l.id LIMIT 6`, [vendedor]);
            datos = s.rows.map(f => ({
                id: null, uuid: null, leadId: f.id, leadUuid: f.uuid, empresa: f.empresa, contacto: f.contacto, telefono: f.telefono,
                direccion: f.direccion, puntaje: f.puntaje, etapa: f.etapa, latitudCliente: num(f.lat), longitudCliente: num(f.lon),
                fechaProgramada: fecha, checkinEn: null, latitud: null, longitud: null, precisionM: null, distanciaM: null,
                motivoDistancia: null, vendedorId: vendedor, sugerida: true
            }));
        }
        res.json({ servidorTiempo: new Date().toISOString(), fecha, sugerida, radioMaximoM: RADIO_MAXIMO_M, total: datos.length, datos });
    } catch (e) { next(e); }
});

router.get('/', permitirRoles(ROL_VENDEDOR, ROL_SUPERVISOR), async (req, res, next) => {
    try {
        const cond = ['NOT v.eliminado'], par = [];
        const p = (x) => { par.push(x); return `$${par.length}`; };
        if (req.usuario.rol === ROL_VENDEDOR) cond.push(`v.vendedor_id = ${p(req.usuario.id)}`);
        else if (req.query.vendedorId) cond.push(`v.vendedor_id = ${p(Number(req.query.vendedorId))}`);
        if (esFechaIso(req.query.fecha)) cond.push(`v.fecha_programada = ${p(req.query.fecha)}`);
        if (req.query.desde) cond.push(`v.actualizado_en > ${p(new Date(req.query.desde))}`);
        if (req.query.conCheckin === '1') cond.push('v.checkin_en IS NOT NULL');
        const r = await query(`${SELECT_VISITA} WHERE ${cond.join(' AND ')} ORDER BY COALESCE(v.checkin_en, v.creado_en) DESC LIMIT 500`, par);
        res.json({ servidorTiempo: new Date().toISOString(), total: r.rowCount, datos: r.rows.map(aDto) });
    } catch (e) { next(e); }
});

router.post('/', permitirRoles(ROL_VENDEDOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'visita', 'REGISTRAR', async (c) => {
        const b = req.body;
        if (!esUuid(b.uuid)) throw new ErrorHttp(422, 'UUID_INVALIDO', 'La visita debe tener un uuid válido.');
        const ya = await c.query('SELECT id FROM visitas WHERE uuid = $1', [b.uuid]);
        if (ya.rowCount) return { status: 200, cuerpo: { dato: aDto((await c.query(`${SELECT_VISITA} WHERE v.id = $1`, [ya.rows[0].id])).rows[0]) } };

        const lead = (await c.query(`SELECT l.id, l.vendedor_id, l.eliminado, COALESCE(l.latitud, cl.latitud)::float8 AS lat,
                                            COALESCE(l.longitud, cl.longitud)::float8 AS lon
                                     FROM leads l LEFT JOIN clientes cl ON cl.id = l.cliente_id WHERE l.uuid = $1`, [b.leadUuid])).rows[0];
        if (!lead || lead.eliminado) throw new ErrorHttp(422, 'LEAD_NO_EXISTE', 'El lead todavía no existe en el servidor (sincroniza primero el lead).');
        if (lead.vendedor_id !== req.usuario.id) throw new ErrorHttp(409, 'REASIGNADO', 'Este lead ya no está asignado a ti.');
        const fecha = esFechaIso(b.fechaProgramada) ? b.fechaProgramada : hoyLima();

        let checkin = null, distancia = null;
        if (b.checkin) {
            const lat = Number(b.checkin.latitud), lon = Number(b.checkin.longitud);
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
                throw new ErrorHttp(422, 'GPS_INVALIDO', 'La ubicación GPS no es válida.');
            }
            const fechaHora = esFechaHoraIso(b.checkin.fechaHora) ? new Date(b.checkin.fechaHora) : new Date();
            checkin = { lat, lon, precision: Number(b.checkin.precisionM) || null, fechaHora };
            if (lead.lat != null) distancia = Math.round(distanciaMetros(lat, lon, lead.lat, lead.lon) * 10) / 10;
        }
        const motivo = String(b.motivoDistancia ?? '').trim() || null;
        if (distancia != null && distancia > RADIO_MAXIMO_M && !motivo) {
            throw new ErrorHttp(422, 'MOTIVO_DISTANCIA_REQUERIDO',
                `Estás a ${Math.round(distancia)} m del cliente (más de ${RADIO_MAXIMO_M} m). Indica el motivo para registrar el check-in.`,
                { distanciaM: distancia });
        }

        // Si ya estaba programada para ese día y sin check-in, se completa esa misma visita
        const prog = await c.query(`SELECT id FROM visitas WHERE lead_id = $1 AND vendedor_id = $2 AND fecha_programada = $3
                                    AND checkin_en IS NULL AND NOT eliminado LIMIT 1 FOR UPDATE`, [lead.id, req.usuario.id, fecha]);
        let id;
        if (prog.rowCount && checkin) {
            id = prog.rows[0].id;
            await c.query(`UPDATE visitas SET checkin_en = $2, latitud = $3, longitud = $4, precision_m = $5, distancia_m = $6, motivo_distancia = $7,
                           version = version + 1, actualizado_en = now() WHERE id = $1`,
                [id, checkin.fechaHora, checkin.lat, checkin.lon, checkin.precision, distancia, motivo]);
        } else {
            const r = await c.query(`INSERT INTO visitas (uuid, lead_id, vendedor_id, fecha_programada, checkin_en, latitud, longitud, precision_m, distancia_m, motivo_distancia)
                                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
                [b.uuid, lead.id, req.usuario.id, fecha, checkin?.fechaHora ?? null, checkin?.lat ?? null, checkin?.lon ?? null,
                    checkin?.precision ?? null, distancia, motivo]);
            id = r.rows[0].id;
        }
        if (checkin) {
            // La visita también cuenta como interacción con el lead y actualiza su puntaje
            await c.query(`INSERT INTO interacciones (uuid, lead_id, tipo, fecha, fecha_hora, nota, resultado, registrado_por)
                           VALUES (gen_random_uuid(), $1, 'Visita', ($2::timestamptz AT TIME ZONE 'America/Lima')::date, $2, $3, 'CONTESTO', $4)`,
                [lead.id, checkin.fechaHora, `Check-in a ${distancia != null ? Math.round(distancia) + ' m' : 'distancia desconocida'}${motivo ? ' · ' + motivo : ''}`, req.usuario.id]);
            await c.query('UPDATE leads SET ultimo_contacto_en = GREATEST(COALESCE(ultimo_contacto_en, $2), $2) WHERE id = $1', [lead.id, checkin.fechaHora]);
            await puntuarLead(c, lead.id);
        }
        const v = await c.query(`${SELECT_VISITA} WHERE v.id = $1`, [id]);
        return { status: 201, cuerpo: { dato: aDto(v.rows[0]) } };
    })
);

module.exports = router;
