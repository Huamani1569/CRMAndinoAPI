// Endpoints de SERVICIO AL CLIENTE — proceso de lealtad (Laudon, fig. 9.9)
//   POST /api/servicio/solicitudes                    cliente: abrir ticket (la API decide prioridad y agente)
//   GET  /api/servicio/solicitudes                    cliente: los de su empresa · agente: su cola · supervisor: todos
//   GET  /api/servicio/solicitudes/:id                detalle con historial (y perfil del cliente para agente/supervisor)
//   POST /api/servicio/solicitudes/:id/foto           cliente: adjuntar foto (image/jpeg, png o webp; máx. 5 MB)
//   GET  /api/servicio/solicitudes/:id/foto           ver la foto
//   PUT  /api/servicio/solicitudes/:id/estado         agente: tomar, resolver o devolver · cliente: cerrar o reabrir
//   POST /api/servicio/solicitudes/:id/calificacion   cliente: calificar de 1 a 5, una sola vez
const express = require('express');
const { query } = require('../db');
const { permitirRoles } = require('../middleware/auth');
const { ejecutarOperacion } = require('../operaciones');
const { ErrorHttp, ROL_AGENTE, ROL_SUPERVISOR, ROL_CLIENTE, esUuid } = require('../errores');
const { notificar, usuariosDeCliente, siguienteNumero, num } = require('../servicios');

const router = express.Router();
router.param('id', (req, res, next, id) => {
    if (!/^\d+$/.test(id)) return res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Identificador no válido.' });
    next();
});

const CATEGORIAS = ['FACTURACION', 'ACCESO', 'ERROR_SISTEMA', 'CAPACITACION', 'OTRO'];
const UMBRAL_ALTO_VALOR = 70;          // RN-06
const SLA_HORAS = { ALTA: 4, NORMAL: 24 };

const SELECT_SRV = `
    SELECT s.*, c.razon_social, c.ruc, a.nombre AS agente_nombre, a.es_senior AS agente_senior,
           (s.sla_hasta - now() < interval '2 hours' AND s.estado IN ('ABIERTA','EN_ATENCION')) AS sla_por_vencer,
           (s.sla_hasta < now() AND s.estado IN ('ABIERTA','EN_ATENCION')) AS sla_vencido,
           EXISTS (SELECT 1 FROM fotos_solicitud f WHERE f.solicitud_id = s.id) AS tiene_foto
    FROM solicitudes_servicio s JOIN clientes c ON c.id = s.cliente_id LEFT JOIN usuarios a ON a.id = s.agente_id`;

function aDto(f, rol) {
    return {
        id: f.id, uuid: f.uuid, numero: f.numero, clienteId: f.cliente_id, empresa: f.razon_social,
        categoria: f.categoria, descripcion: f.descripcion, tieneFoto: f.tiene_foto,
        fotoUrl: f.tiene_foto ? `/api/servicio/solicitudes/${f.id}/foto` : null,
        prioridad: f.prioridad, clientePreferente: f.prioridad === 'ALTA',
        // el puntaje numérico solo lo ven el agente y el supervisor
        puntajeCliente: rol === ROL_CLIENTE ? undefined : f.puntaje_cliente,
        agenteId: f.agente_id, agenteNombre: f.agente_nombre, agenteSenior: f.agente_senior === true,
        estado: f.estado, slaHasta: f.sla_hasta, slaPorVencer: f.sla_por_vencer === true, slaVencido: f.sla_vencido === true,
        solucion: f.solucion, resueltaEn: f.resuelta_en, cerradaEn: f.cerrada_en,
        calificacion: f.calificacion, comentarioCalificacion: f.comentario_calif,
        creadoEn: f.creado_en, version: f.version, actualizadoEn: f.actualizado_en
    };
}

// Si el cliente no confirma en 48 h, RESUELTA pasa a CERRADA sola
async function cerrarResueltas(c = { query }) {
    await c.query(`UPDATE solicitudes_servicio SET estado = 'CERRADA', cerrada_en = now(), version = version + 1, actualizado_en = now()
                   WHERE estado = 'RESUELTA' AND resuelta_en < now() - interval '48 hours'`);
}

function condicionRol(req, p) {
    if (req.usuario.rol === ROL_CLIENTE) return `s.cliente_id = ${p(req.usuario.clienteId)}`;
    if (req.usuario.rol === ROL_AGENTE) {
        if (req.query.cola === 'general') return 's.agente_id IS NULL';
        if (req.query.cola === 'todas') return 'TRUE';
        return `(s.agente_id = ${p(req.usuario.id)} OR s.agente_id IS NULL)`;
    }
    if (req.usuario.rol === ROL_SUPERVISOR) return 'TRUE';
    throw new ErrorHttp(403, 'SIN_PERMISO', 'Tu rol no puede ver solicitudes de servicio.');
}

// ---------------------------------------------------------------- consultas
router.get('/solicitudes', async (req, res, next) => {
    try {
        await cerrarResueltas();
        const par = [];
        const p = (v) => { par.push(v); return `$${par.length}`; };
        const cond = [condicionRol(req, p)];
        if (req.query.estado) cond.push(`s.estado = ANY(${p(String(req.query.estado).split(','))})`);
        else if (req.usuario.rol === ROL_AGENTE && !req.query.desde) cond.push("s.estado IN ('ABIERTA','EN_ATENCION','RESUELTA')");
        if (req.query.desde) cond.push(`s.actualizado_en > ${p(new Date(req.query.desde))}`);
        // RF-S04: primero la prioridad alta, luego la más antigua
        const orden = req.usuario.rol === ROL_CLIENTE ? 's.creado_en DESC'
            : "(s.estado IN ('ABIERTA','EN_ATENCION')) DESC, (s.prioridad = 'ALTA') DESC, s.creado_en ASC";
        const r = await query(`${SELECT_SRV} WHERE ${cond.join(' AND ')} ORDER BY ${orden} LIMIT 300`, par);
        res.json({ servidorTiempo: new Date().toISOString(), total: r.rowCount, datos: r.rows.map(f => aDto(f, req.usuario.rol)) });
    } catch (e) {
        if (e instanceof ErrorHttp) return res.status(e.status).json(e.cuerpo());
        next(e);
    }
});

async function perfilCliente(clienteId) {
    const r = await query(`
        SELECT c.id, c.ruc, c.razon_social, c.fecha_alta, c.puntaje_valor, c.prob_cancelacion::float8 AS prob, c.cltv::float8 AS cltv,
               v.nombre AS vendedor,
               (SELECT count(*) FROM cotizaciones co JOIN leads l ON l.id = co.lead_id WHERE l.cliente_id = c.id AND co.estado = 'ACEPTADA')::int AS compras,
               (SELECT COALESCE(sum(co.total), 0) FROM cotizaciones co JOIN leads l ON l.id = co.lead_id WHERE l.cliente_id = c.id AND co.estado = 'ACEPTADA')::float8 AS monto,
               (SELECT count(*) FROM solicitudes_servicio s WHERE s.cliente_id = c.id)::int AS tickets,
               (SELECT avg(calificacion) FROM solicitudes_servicio s WHERE s.cliente_id = c.id AND calificacion IS NOT NULL)::float8 AS csat
        FROM clientes c LEFT JOIN usuarios v ON v.id = c.vendedor_id WHERE c.id = $1`, [clienteId]);
    const f = r.rows[0];
    return {
        id: f.id, ruc: f.ruc.trim(), razonSocial: f.razon_social, clienteDesde: f.fecha_alta, vendedorNombre: f.vendedor,
        puntajeValor: f.puntaje_valor, probCancelacion: num(f.prob), cltv: num(f.cltv),
        compras: f.compras, comprasTotal: f.monto, ticketsPrevios: f.tickets, csatPromedio: f.csat == null ? null : Math.round(f.csat * 10) / 10
    };
}

router.get('/solicitudes/:id', async (req, res, next) => {
    try {
        await cerrarResueltas();
        const par = [req.params.id];
        const p = (v) => { par.push(v); return `$${par.length}`; };
        const r = await query(`${SELECT_SRV} WHERE s.id = $1 AND ${condicionRol({ ...req, query: { cola: 'todas' } }, p)}`, par);
        const f = r.rows[0];
        if (!f) return res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Solicitud no encontrada.' });
        const ev = await query(`SELECT e.estado_anterior, e.estado_nuevo, e.nota, e.fecha, u.nombre FROM eventos_solicitud e
                                LEFT JOIN usuarios u ON u.id = e.usuario_id WHERE e.solicitud_id = $1 ORDER BY e.fecha DESC, e.id DESC`, [f.id]);
        const dato = {
            ...aDto(f, req.usuario.rol),
            historial: ev.rows.map(e => ({ estado: e.estado_nuevo, estadoAnterior: e.estado_anterior, nota: e.nota, usuarioNombre: e.nombre, fecha: e.fecha }))
        };
        if (req.usuario.rol !== ROL_CLIENTE) dato.perfilCliente = await perfilCliente(f.cliente_id);
        res.json({ dato });
    } catch (e) {
        if (e instanceof ErrorHttp) return res.status(e.status).json(e.cuerpo());
        next(e);
    }
});

// ---------------------------------------------------------------- abrir ticket (proceso de lealtad)
router.post('/solicitudes', permitirRoles(ROL_CLIENTE), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'solicitud_servicio', 'CREAR', async (c) => {
        const b = req.body;
        if (!esUuid(b.uuid)) throw new ErrorHttp(422, 'UUID_INVALIDO', 'La solicitud debe tener un uuid válido.');
        const ya = await c.query(`${SELECT_SRV} WHERE s.uuid = $1`, [b.uuid]);
        if (ya.rowCount) return { status: 200, cuerpo: { dato: aDto(ya.rows[0], ROL_CLIENTE) } };
        const categoria = String(b.categoria || '').toUpperCase();
        const descripcion = String(b.descripcion || '').trim();
        if (!CATEGORIAS.includes(categoria)) throw new ErrorHttp(422, 'CATEGORIA_INVALIDA', 'Elige una categoría.');
        if (descripcion.length < 20) throw new ErrorHttp(422, 'DESCRIPCION_CORTA', 'Describe el problema con al menos 20 caracteres.');

        // 1) Obtener la información del cliente  2) Calificarlo  3) Canalizar al mejor agente
        const cli = (await c.query('SELECT puntaje_valor FROM clientes WHERE id = $1', [req.usuario.clienteId])).rows[0];
        const puntaje = cli?.puntaje_valor ?? null;
        const prioridad = puntaje != null && puntaje >= UMBRAL_ALTO_VALOR ? 'ALTA' : 'NORMAL';
        let agente = null;
        if (puntaje != null) {
            const a = await c.query(`
                SELECT u.id, u.nombre FROM usuarios u
                LEFT JOIN solicitudes_servicio s ON s.agente_id = u.id AND s.estado IN ('ABIERTA','EN_ATENCION')
                WHERE u.rol = 'agente' AND u.activo ${prioridad === 'ALTA' ? 'AND u.es_senior' : ''}
                GROUP BY u.id ORDER BY count(s.id), u.id LIMIT 1`);
            agente = a.rows[0] || null;
        }   // sin información del cliente → cola general (agente NULL)

        const numero = await siguienteNumero(c, 'SRV');
        const r = await c.query(
            `INSERT INTO solicitudes_servicio (uuid, numero, cliente_id, creada_por, categoria, descripcion, puntaje_cliente, prioridad, agente_id, sla_hasta)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(hours => $10)) RETURNING id`,
            [b.uuid, numero, req.usuario.clienteId, req.usuario.id, categoria, descripcion, puntaje, prioridad, agente?.id ?? null, SLA_HORAS[prioridad]]);
        const id = r.rows[0].id;
        const empresa = (await c.query('SELECT razon_social FROM clientes WHERE id = $1', [req.usuario.clienteId])).rows[0].razon_social;
        if (agente) {
            await notificar(c, agente.id, 'TICKET_ASIGNADO', `Nuevo ticket ${prioridad === 'ALTA' ? '· PRIORIDAD ALTA' : ''}`.trim(),
                `${numero} · ${empresa} · SLA ${SLA_HORAS[prioridad]} h`, 'solicitud', id);
        } else {
            const agentes = (await c.query("SELECT id FROM usuarios WHERE rol = 'agente' AND activo")).rows.map(x => x.id);
            await notificar(c, agentes, 'TICKET_COLA', 'Nuevo ticket en la cola general', `${numero} · ${empresa}`, 'solicitud', id);
        }
        const f = (await c.query(`${SELECT_SRV} WHERE s.id = $1`, [id])).rows[0];
        return { status: 201, cuerpo: { dato: aDto(f, ROL_CLIENTE) } };
    })
);

// ---------------------------------------------------------------- foto
router.post('/solicitudes/:id/foto', permitirRoles(ROL_CLIENTE),
    express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '5mb' }),
    async (req, res, next) => {
        try {
            const tipo = (req.get('Content-Type') || '').split(';')[0];
            if (!Buffer.isBuffer(req.body) || !req.body.length) {
                return res.status(415).json({ error: 'FOTO_INVALIDA', mensaje: 'Envía la foto como image/jpeg, image/png o image/webp.' });
            }
            const s = await query('SELECT id FROM solicitudes_servicio WHERE id = $1 AND cliente_id = $2', [req.params.id, req.usuario.clienteId]);
            if (!s.rowCount) return res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Solicitud no encontrada.' });
            await query(`INSERT INTO fotos_solicitud (solicitud_id, tipo_mime, datos) VALUES ($1, $2, $3)
                         ON CONFLICT (solicitud_id) DO UPDATE SET tipo_mime = $2, datos = $3, subida_en = now()`, [req.params.id, tipo, req.body]);
            await query('UPDATE solicitudes_servicio SET foto_url = $2, actualizado_en = now() WHERE id = $1', [req.params.id, `/api/servicio/solicitudes/${req.params.id}/foto`]);
            res.json({ fotoUrl: `/api/servicio/solicitudes/${req.params.id}/foto`, bytes: req.body.length });
        } catch (e) { next(e); }
    });

router.get('/solicitudes/:id/foto', async (req, res, next) => {
    try {
        const par = [req.params.id];
        const filtro = req.usuario.rol === ROL_CLIENTE ? (par.push(req.usuario.clienteId), ' AND s.cliente_id = $2') : '';
        const r = await query(`SELECT f.tipo_mime, f.datos FROM fotos_solicitud f JOIN solicitudes_servicio s ON s.id = f.solicitud_id
                               WHERE f.solicitud_id = $1${filtro}`, par);
        if (!r.rowCount) return res.status(404).json({ error: 'SIN_FOTO', mensaje: 'Esta solicitud no tiene foto.' });
        res.set('Content-Type', r.rows[0].tipo_mime).send(r.rows[0].datos);
    } catch (e) { next(e); }
});

// ---------------------------------------------------------------- cambio de estado
const TEXTO_ESTADO = { EN_ATENCION: 'está en atención', RESUELTA: 'fue resuelta', CERRADA: 'fue cerrada', ABIERTA: 'volvió a la cola' };

router.put('/solicitudes/:id/estado', permitirRoles(ROL_AGENTE, ROL_CLIENTE, ROL_SUPERVISOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'solicitud_servicio', 'ESTADO', async (c) => {
        const s = (await c.query(`${SELECT_SRV} WHERE s.id = $1 FOR UPDATE OF s`, [req.params.id])).rows[0];
        if (!s || (req.usuario.rol === ROL_CLIENTE && s.cliente_id !== req.usuario.clienteId)) throw new ErrorHttp(404, 'NO_ENCONTRADO', 'Solicitud no encontrada.');
        if (req.body.version != null && Number(req.body.version) !== s.version) {
            throw new ErrorHttp(409, 'CONFLICTO_VERSION', 'La solicitud cambió mientras la veías.', { actual: aDto(s, req.usuario.rol) });
        }
        const nuevo = String(req.body.estado || '').toUpperCase();
        const nota = String(req.body.nota || '').trim().slice(0, 300) || null;
        const permitidos = req.usuario.rol === ROL_CLIENTE
            ? { RESUELTA: ['CERRADA', 'EN_ATENCION'] }
            : { ABIERTA: ['EN_ATENCION'], EN_ATENCION: ['RESUELTA', 'ABIERTA'] };
        if (!(permitidos[s.estado] || []).includes(nuevo)) {
            throw new ErrorHttp(422, 'TRANSICION_INVALIDA', `No se puede pasar de ${s.estado} a ${nuevo || '(vacío)'}.`);
        }
        if (req.usuario.rol === ROL_AGENTE && s.agente_id && s.agente_id !== req.usuario.id) {
            throw new ErrorHttp(409, 'ASIGNADA_A_OTRO', `Esta solicitud la atiende ${s.agente_nombre}.`);
        }
        const sets = ['estado = $2', 'version = version + 1', 'actualizado_en = now()'];
        const par = [s.id, nuevo];
        if (nuevo === 'EN_ATENCION' && req.usuario.rol !== ROL_CLIENTE) { par.push(req.usuario.id); sets.push(`agente_id = $${par.length}`); }
        if (nuevo === 'ABIERTA') sets.push('agente_id = NULL');
        if (nuevo === 'RESUELTA') {
            const solucion = String(req.body.solucion || '').trim();
            if (solucion.length < 5) throw new ErrorHttp(422, 'SOLUCION_OBLIGATORIA', 'Describe la solución antes de marcarla como resuelta.');
            par.push(solucion); sets.push(`solucion = $${par.length}`, 'resuelta_en = now()');
        }
        if (nuevo === 'CERRADA') sets.push('cerrada_en = now()');
        await c.query(`UPDATE solicitudes_servicio SET ${sets.join(', ')} WHERE id = $1`, par);
        if (nota) await c.query('UPDATE eventos_solicitud SET nota = $2 WHERE id = (SELECT max(id) FROM eventos_solicitud WHERE solicitud_id = $1)', [s.id, nota]);

        if (req.usuario.rol === ROL_CLIENTE) {
            if (s.agente_id) await notificar(c, s.agente_id, 'TICKET_CLIENTE', nuevo === 'CERRADA' ? 'El cliente confirmó la solución' : 'El cliente reabrió el ticket',
                `${s.numero} · ${s.razon_social}`, 'solicitud', s.id);
        } else {
            await notificar(c, await usuariosDeCliente(c, s.cliente_id), 'TICKET_ESTADO', `Tu solicitud ${TEXTO_ESTADO[nuevo]}`,
                `${s.numero}${nuevo === 'RESUELTA' ? ' · confirma la solución y califica la atención' : ''}`, 'solicitud', s.id);
        }
        const f = (await c.query(`${SELECT_SRV} WHERE s.id = $1`, [s.id])).rows[0];
        return { status: 200, cuerpo: { dato: aDto(f, req.usuario.rol) } };
    })
);

// ---------------------------------------------------------------- calificación (RF-P12)
router.post('/solicitudes/:id/calificacion', permitirRoles(ROL_CLIENTE), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'solicitud_servicio', 'CALIFICAR', async (c) => {
        const s = (await c.query(`${SELECT_SRV} WHERE s.id = $1 AND s.cliente_id = $2 FOR UPDATE OF s`, [req.params.id, req.usuario.clienteId])).rows[0];
        if (!s) throw new ErrorHttp(404, 'NO_ENCONTRADO', 'Solicitud no encontrada.');
        if (s.calificacion != null) throw new ErrorHttp(409, 'YA_CALIFICADA', 'Ya calificaste esta atención. ¡Gracias!');
        if (!['RESUELTA', 'CERRADA'].includes(s.estado)) throw new ErrorHttp(422, 'AUN_NO_RESUELTA', 'Podrás calificar cuando la solicitud esté resuelta.');
        const nota = Number(req.body.calificacion);
        if (!Number.isInteger(nota) || nota < 1 || nota > 5) throw new ErrorHttp(422, 'CALIFICACION_INVALIDA', 'La calificación debe ser de 1 a 5.');
        const comentario = String(req.body.comentario || '').trim().slice(0, 300) || null;
        await c.query(`UPDATE solicitudes_servicio SET calificacion = $2, comentario_calif = $3, calificada_en = now(),
                       estado = 'CERRADA', cerrada_en = COALESCE(cerrada_en, now()), version = version + 1, actualizado_en = now() WHERE id = $1`,
            [s.id, nota, comentario]);
        // La satisfacción mueve un poco el puntaje de valor y lealtad (se recalcula completo al reentrenar)
        await c.query('UPDATE clientes SET puntaje_valor = LEAST(100, GREATEST(0, puntaje_valor + $2)) WHERE id = $1 AND puntaje_valor IS NOT NULL',
            [s.cliente_id, (nota - 3) * 2]);
        if (s.agente_id) await notificar(c, s.agente_id, 'TICKET_CALIFICADO', `Te calificaron con ${nota} ★`, `${s.numero} · ${s.razon_social}`, 'solicitud', s.id);
        const f = (await c.query(`${SELECT_SRV} WHERE s.id = $1`, [s.id])).rows[0];
        return { status: 201, cuerpo: { dato: aDto(f, ROL_CLIENTE) } };
    })
);

module.exports = router;
