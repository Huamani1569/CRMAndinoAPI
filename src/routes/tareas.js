// Endpoints de TAREAS (recordatorios de seguimiento con fecha límite).
//   GET    /api/tareas          vendedor: las de sus leads · supervisor: todas (consulta, RF07)
//   GET    /api/tareas/:id
//   POST   /api/tareas          solo vendedor
//   PUT    /api/tareas/:id      solo vendedor (editar / marcar completada)
//   DELETE /api/tareas/:id      solo vendedor
const express = require('express');
const { query } = require('../db');
const { permitirRoles } = require('../middleware/auth');
const { ejecutarOperacion } = require('../operaciones');
const { ErrorHttp, ROL_VENDEDOR, esUuid, esFechaIso } = require('../errores');
const { validarIdParam, leadPermitido } = require('./comun');

const router = express.Router();
validarIdParam(router);

const SELECT_TAREA = `
    SELECT t.id, t.uuid, t.lead_id, l.uuid AS lead_uuid, l.empresa AS lead_empresa, t.descripcion,
           to_char(t.fecha_limite, 'YYYY-MM-DD') AS fecha_limite, t.completada, t.version, t.eliminado,
           t.actualizado_en, l.vendedor_id, u.nombre AS vendedor_nombre
    FROM tareas t
    JOIN leads l ON l.id = t.lead_id
    JOIN usuarios u ON u.id = l.vendedor_id`;

function aDto(f) {
    return {
        id: f.id,
        uuid: f.uuid,
        leadId: f.lead_id,
        leadUuid: f.lead_uuid,
        leadEmpresa: f.lead_empresa,
        descripcion: f.descripcion,
        fechaLimite: f.fecha_limite,
        completada: f.completada,
        vendedorId: f.vendedor_id,
        vendedorNombre: f.vendedor_nombre,
        version: f.version,
        eliminado: f.eliminado,
        actualizadoEn: f.actualizado_en
    };
}

async function buscar(cliente, id, bloquear = false) {
    const r = await cliente.query(`${SELECT_TAREA} WHERE t.id = $1 ${bloquear ? 'FOR UPDATE OF t' : ''}`, [id]);
    return r.rows[0];
}

function validar(body) {
    const descripcion = String(body.descripcion ?? '').trim();
    const fechaLimite = body.fechaLimite;
    if (!descripcion) throw new ErrorHttp(422, 'DESCRIPCION_OBLIGATORIA', 'Escribe la descripción de la tarea.');
    if (!esFechaIso(fechaLimite)) throw new ErrorHttp(422, 'FECHA_INVALIDA', 'La fecha límite debe tener el formato AAAA-MM-DD.');
    return { descripcion, fechaLimite, completada: body.completada === true };
}

async function verificarEdicion(cliente, req, version) {
    const actual = await buscar(cliente, req.params.id, true);
    if (!actual) throw new ErrorHttp(404, 'NO_ENCONTRADO', 'La tarea no existe en el servidor.');
    if (actual.vendedor_id !== req.usuario.id) {
        throw new ErrorHttp(409, 'REASIGNADO', 'El lead de esta tarea ya no está asignado a ti.', { actual: aDto(actual) });
    }
    if (actual.eliminado) throw new ErrorHttp(409, 'ELIMINADO', 'Esta tarea ya fue eliminada.', { actual: aDto(actual) });
    if (version != null && Number(version) !== actual.version) {
        throw new ErrorHttp(409, 'CONFLICTO_VERSION', `La tarea cambió en el servidor (versión ${actual.version}).`, { actual: aDto(actual) });
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
        if (req.query.desde) {
            parametros.push(new Date(req.query.desde));
            condiciones.push(`t.actualizado_en > $${parametros.length}`);
        } else {
            condiciones.push('t.eliminado = FALSE AND l.eliminado = FALSE');
        }
        const r = await query(`${SELECT_TAREA} WHERE ${condiciones.join(' AND ')} ORDER BY t.fecha_limite, t.id`, parametros);
        res.json({ servidorTiempo: new Date().toISOString(), total: r.rowCount, datos: r.rows.map(aDto) });
    } catch (error) {
        next(error);
    }
});

router.get('/:id', async (req, res, next) => {
    try {
        const r = await query(`${SELECT_TAREA} WHERE t.id = $1 AND t.eliminado = FALSE`, [req.params.id]);
        const fila = r.rows[0];
        if (!fila || (req.usuario.rol === ROL_VENDEDOR && fila.vendedor_id !== req.usuario.id)) {
            return res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Tarea no encontrada.' });
        }
        res.json({ dato: aDto(fila) });
    } catch (error) {
        next(error);
    }
});

router.post('/', permitirRoles(ROL_VENDEDOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'tarea', 'CREAR', async (cliente) => {
        if (!esUuid(req.body.uuid)) throw new ErrorHttp(422, 'UUID_INVALIDO', 'La tarea debe tener un uuid válido.');
        const { descripcion, fechaLimite, completada } = validar(req.body);
        const lead = await leadPermitido(cliente, req.usuario, req.body.leadUuid);

        const existente = await cliente.query('SELECT id FROM tareas WHERE uuid = $1', [req.body.uuid]);
        if (existente.rowCount > 0) {
            return { status: 200, cuerpo: { dato: aDto(await buscar(cliente, existente.rows[0].id)) } };
        }
        const r = await cliente.query(
            `INSERT INTO tareas (uuid, lead_id, descripcion, fecha_limite, completada)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [req.body.uuid, lead.id, descripcion, fechaLimite, completada]
        );
        return { status: 201, cuerpo: { dato: aDto(await buscar(cliente, r.rows[0].id)) } };
    })
);

router.put('/:id', permitirRoles(ROL_VENDEDOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'tarea', 'ACTUALIZAR', async (cliente) => {
        const actual = await verificarEdicion(cliente, req, req.body.version);
        const { descripcion, fechaLimite, completada } = validar(req.body);
        await cliente.query(
            `UPDATE tareas SET descripcion = $2, fecha_limite = $3, completada = $4, version = version + 1, actualizado_en = now()
             WHERE id = $1`,
            [actual.id, descripcion, fechaLimite, completada]
        );
        return { status: 200, cuerpo: { dato: aDto(await buscar(cliente, actual.id)) } };
    })
);

router.delete('/:id', permitirRoles(ROL_VENDEDOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'tarea', 'ELIMINAR', async (cliente) => {
        const actual = await verificarEdicion(cliente, req, req.query.version);
        await cliente.query(
            'UPDATE tareas SET eliminado = TRUE, version = version + 1, actualizado_en = now() WHERE id = $1',
            [actual.id]
        );
        return { status: 200, cuerpo: { dato: aDto(await buscar(cliente, actual.id)) } };
    })
);

module.exports = router;
