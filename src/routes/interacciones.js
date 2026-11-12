// Endpoints de INTERACCIONES (llamada, WhatsApp, correo, reunión o visita con un lead).
//   GET    /api/interacciones         vendedor: las de sus leads · supervisor: todas (consulta)
//   GET    /api/interacciones/:id
//   POST   /api/interacciones         solo vendedor
//   PUT    /api/interacciones/:id     solo vendedor
//   DELETE /api/interacciones/:id     solo vendedor
const express = require('express');
const { query } = require('../db');
const { permitirRoles } = require('../middleware/auth');
const { ejecutarOperacion } = require('../operaciones');
const { ErrorHttp, TIPOS_INTERACCION, RESULTADOS_CONTACTO, ROL_VENDEDOR, ROL_SUPERVISOR, esUuid, esFechaIso, esFechaHoraIso } = require('../errores');
const { puntuarLead } = require('../ml');
const { validarIdParam, leadPermitido } = require('./comun');

const router = express.Router();
// Solo vendedor y supervisor trabajan con leads, interacciones y tareas
router.use(permitirRoles(ROL_VENDEDOR, ROL_SUPERVISOR));
validarIdParam(router);

const SELECT_INTERACCION = `
    SELECT i.id, i.uuid, i.lead_id, l.uuid AS lead_uuid, i.tipo, to_char(i.fecha, 'YYYY-MM-DD') AS fecha,
           i.fecha_hora, i.resultado, i.nota, i.registrado_por, i.version, i.eliminado, i.actualizado_en, l.vendedor_id
    FROM interacciones i
    JOIN leads l ON l.id = i.lead_id`;

function aDto(f) {
    return {
        id: f.id,
        uuid: f.uuid,
        leadId: f.lead_id,
        leadUuid: f.lead_uuid,
        tipo: f.tipo,
        fecha: f.fecha,
        fechaHora: f.fecha_hora,
        resultado: f.resultado,
        nota: f.nota,
        registradoPor: f.registrado_por,
        version: f.version,
        eliminado: f.eliminado,
        actualizadoEn: f.actualizado_en
    };
}

async function buscar(cliente, id, bloquear = false) {
    const r = await cliente.query(`${SELECT_INTERACCION} WHERE i.id = $1 ${bloquear ? 'FOR UPDATE OF i' : ''}`, [id]);
    return r.rows[0];
}

// Fecha y hora automáticas: la app envía fechaHora (o solo fecha, como en el parcial).
// La nota es obligatoria solo en reuniones (RF-V06).
function validar(body) {
    const tipo = body.tipo;
    const nota = String(body.nota ?? '').trim();
    let fechaHora;
    if (esFechaHoraIso(body.fechaHora)) fechaHora = new Date(body.fechaHora);
    else if (esFechaIso(body.fecha)) fechaHora = new Date(body.fecha + 'T12:00:00-05:00');
    else if (body.fecha == null && body.fechaHora == null) fechaHora = new Date();
    else throw new ErrorHttp(422, 'FECHA_INVALIDA', 'La fecha debe tener el formato AAAA-MM-DD.');
    const fecha = new Date(fechaHora.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 10);
    const resultado = body.resultado || null;
    if (!TIPOS_INTERACCION.includes(tipo)) throw new ErrorHttp(422, 'TIPO_INVALIDO', `El tipo debe ser: ${TIPOS_INTERACCION.join(', ')}.`);
    if (resultado && !RESULTADOS_CONTACTO.includes(resultado)) throw new ErrorHttp(422, 'RESULTADO_INVALIDO', `El resultado debe ser: ${RESULTADOS_CONTACTO.join(', ')}.`);
    if (tipo === 'Reunión' && !nota) throw new ErrorHttp(422, 'NOTA_OBLIGATORIA', 'En una reunión la nota es obligatoria.');
    return { tipo, fecha, fechaHora, nota, resultado };
}

// Verifica que la interacción exista, no esté eliminada y que la versión coincida.
async function verificarEdicion(cliente, req) {
    const actual = await buscar(cliente, req.params.id, true);
    if (!actual) throw new ErrorHttp(404, 'NO_ENCONTRADO', 'La interacción no existe en el servidor.');
    if (actual.vendedor_id !== req.usuario.id) {
        throw new ErrorHttp(409, 'REASIGNADO', 'El lead de esta interacción ya no está asignado a ti.', { actual: aDto(actual) });
    }
    if (actual.eliminado) throw new ErrorHttp(409, 'ELIMINADO', 'Esta interacción ya fue eliminada.', { actual: aDto(actual) });
    if (req.body.version != null && Number(req.body.version) !== actual.version) {
        throw new ErrorHttp(409, 'CONFLICTO_VERSION',
            `La interacción cambió en el servidor (versión ${actual.version}).`, { actual: aDto(actual) });
    }
    return actual;
}

router.get('/', async (req, res, next) => {
    try {
        const parametros = [];
        const condiciones = [];
        if (req.usuario.rol === ROL_VENDEDOR) {
            parametros.push(req.usuario.id);
            condiciones.push(`l.vendedor_id = $${parametros.length}`);
        }
        if (req.query.leadId) {
            parametros.push(Number(req.query.leadId));
            condiciones.push(`i.lead_id = $${parametros.length}`);
        }
        if (req.query.desde) {
            parametros.push(new Date(req.query.desde));
            condiciones.push(`i.actualizado_en > $${parametros.length}`);
        } else {
            condiciones.push('i.eliminado = FALSE AND l.eliminado = FALSE');
        }
        const r = await query(`${SELECT_INTERACCION} WHERE ${condiciones.join(' AND ')} ORDER BY i.fecha_hora DESC, i.id DESC`, parametros);
        res.json({ servidorTiempo: new Date().toISOString(), total: r.rowCount, datos: r.rows.map(aDto) });
    } catch (error) {
        next(error);
    }
});

router.get('/:id', async (req, res, next) => {
    try {
        const r = await query(`${SELECT_INTERACCION} WHERE i.id = $1 AND i.eliminado = FALSE`, [req.params.id]);
        const fila = r.rows[0];
        if (!fila || (req.usuario.rol === ROL_VENDEDOR && fila.vendedor_id !== req.usuario.id)) {
            return res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Interacción no encontrada.' });
        }
        res.json({ dato: aDto(fila) });
    } catch (error) {
        next(error);
    }
});

router.post('/', permitirRoles(ROL_VENDEDOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'interaccion', 'CREAR', async (cliente) => {
        if (!esUuid(req.body.uuid)) throw new ErrorHttp(422, 'UUID_INVALIDO', 'La interacción debe tener un uuid válido.');
        const { tipo, fecha, fechaHora, nota, resultado } = validar(req.body);
        const lead = await leadPermitido(cliente, req.usuario, req.body.leadUuid);

        const existente = await cliente.query('SELECT id FROM interacciones WHERE uuid = $1', [req.body.uuid]);
        if (existente.rowCount > 0) {
            return { status: 200, cuerpo: { dato: aDto(await buscar(cliente, existente.rows[0].id)) } };
        }
        const r = await cliente.query(
            `INSERT INTO interacciones (uuid, lead_id, tipo, fecha, fecha_hora, nota, resultado, registrado_por)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [req.body.uuid, lead.id, tipo, fecha, fechaHora, nota, resultado, req.usuario.id]
        );
        // El contacto reinicia los "días sin contacto" (RF-V03) y recalcula el puntaje (ML-01)
        await cliente.query('UPDATE leads SET ultimo_contacto_en = GREATEST(COALESCE(ultimo_contacto_en, $2), $2) WHERE id = $1', [lead.id, fechaHora]);
        await puntuarLead(cliente, lead.id);
        return { status: 201, cuerpo: { dato: aDto(await buscar(cliente, r.rows[0].id)) } };
    })
);

router.put('/:id', permitirRoles(ROL_VENDEDOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'interaccion', 'ACTUALIZAR', async (cliente) => {
        const actual = await verificarEdicion(cliente, req);
        const { tipo, fecha, fechaHora, nota, resultado } = validar(req.body);
        await cliente.query(
            `UPDATE interacciones SET tipo = $2, fecha = $3, fecha_hora = $4, nota = $5, resultado = $6, version = version + 1, actualizado_en = now()
             WHERE id = $1`,
            [actual.id, tipo, fecha, fechaHora, nota, resultado]
        );
        return { status: 200, cuerpo: { dato: aDto(await buscar(cliente, actual.id)) } };
    })
);

router.delete('/:id', permitirRoles(ROL_VENDEDOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'interaccion', 'ELIMINAR', async (cliente) => {
        req.body = { ...(req.body || {}), version: req.query.version };
        const actual = await verificarEdicion(cliente, req);
        await cliente.query(
            'UPDATE interacciones SET eliminado = TRUE, version = version + 1, actualizado_en = now() WHERE id = $1',
            [actual.id]
        );
        return { status: 200, cuerpo: { dato: aDto(await buscar(cliente, actual.id)) } };
    })
);

module.exports = router;
