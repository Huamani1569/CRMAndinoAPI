// Endpoints de LEADS.
//   GET    /api/leads            vendedor: solo sus leads · supervisor: todos
//   GET    /api/leads/:id
//   POST   /api/leads            solo vendedor (crea un lead propio)
//   PUT    /api/leads/:id        vendedor: sus leads (no puede reasignar) · supervisor: editar/reasignar
//   DELETE /api/leads/:id        solo supervisor (descartar lead)
const express = require('express');
const { query } = require('../db');
const { permitirRoles } = require('../middleware/auth');
const { ejecutarOperacion } = require('../operaciones');
const { ErrorHttp, ETAPAS, ROL_VENDEDOR, ROL_SUPERVISOR, esUuid } = require('../errores');

const router = express.Router();

// El :id debe ser un número entero; si no, el lead "no existe".
router.param('id', (req, res, next, id) => {
    if (!/^\d+$/.test(id)) return res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Identificador no válido.' });
    next();
});

const SELECT_LEAD = `
    SELECT l.id, l.uuid, l.empresa, l.contacto, l.valor_potencial::float8 AS valor_potencial,
           l.etapa, l.vendedor_id, u.nombre AS vendedor_nombre, l.version, l.eliminado, l.actualizado_en
    FROM leads l
    JOIN usuarios u ON u.id = l.vendedor_id`;

// Fila de la BD → JSON (DTO) que recibe la app
function aDto(f) {
    return {
        id: f.id,
        uuid: f.uuid,
        empresa: f.empresa,
        contacto: f.contacto,
        valorPotencial: Number(f.valor_potencial),
        etapa: f.etapa,
        vendedorId: f.vendedor_id,
        vendedorNombre: f.vendedor_nombre,
        version: f.version,
        eliminado: f.eliminado,
        actualizadoEn: f.actualizado_en
    };
}

async function buscarLead(cliente, id, bloquear = false) {
    const r = await cliente.query(`${SELECT_LEAD} WHERE l.id = $1 ${bloquear ? 'FOR UPDATE OF l' : ''}`, [id]);
    return r.rows[0];
}

// Reglas de negocio del lead (validación en el servidor).
function validarLead(body) {
    const empresa = String(body.empresa ?? '').trim();
    const contacto = String(body.contacto ?? '').trim();
    const valor = Number(body.valorPotencial);
    const etapa = body.etapa;
    if (!empresa) throw new ErrorHttp(422, 'EMPRESA_OBLIGATORIA', 'No se puede guardar un lead sin empresa.');
    if (!Number.isFinite(valor) || valor < 0) throw new ErrorHttp(422, 'VALOR_INVALIDO', 'El valor potencial debe ser un número mayor o igual a 0.');
    if (!ETAPAS.includes(etapa)) throw new ErrorHttp(422, 'ETAPA_INVALIDA', `La etapa debe ser una de: ${ETAPAS.join(', ')}.`);
    return { empresa, contacto, valor, etapa };
}

// ---------- Consultas ----------
router.get('/', async (req, res, next) => {
    try {
        const condiciones = [];
        const parametros = [];
        if (req.usuario.rol === ROL_VENDEDOR) {
            parametros.push(req.usuario.id);
            condiciones.push(`l.vendedor_id = $${parametros.length}`);
        }
        // ?desde=fecha → solo los cambios posteriores (incluye eliminados para que la app los quite)
        if (req.query.desde) {
            parametros.push(new Date(req.query.desde));
            condiciones.push(`l.actualizado_en > $${parametros.length}`);
        } else {
            condiciones.push('l.eliminado = FALSE');
        }
        const where = condiciones.length ? 'WHERE ' + condiciones.join(' AND ') : '';
        const r = await query(`${SELECT_LEAD} ${where} ORDER BY l.id`, parametros);
        res.json({ servidorTiempo: new Date().toISOString(), total: r.rowCount, datos: r.rows.map(aDto) });
    } catch (error) {
        next(error);
    }
});

router.get('/:id', async (req, res, next) => {
    try {
        const r = await query(`${SELECT_LEAD} WHERE l.id = $1 AND l.eliminado = FALSE`, [req.params.id]);
        const lead = r.rows[0];
        if (!lead || (req.usuario.rol === ROL_VENDEDOR && lead.vendedor_id !== req.usuario.id)) {
            return res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Lead no encontrado.' });
        }
        res.json({ dato: aDto(lead) });
    } catch (error) {
        next(error);
    }
});

// ---------- Escrituras (todas con X-Operacion-UUID) ----------
router.post('/', permitirRoles(ROL_VENDEDOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'lead', 'CREAR', async (cliente) => {
        if (!esUuid(req.body.uuid)) throw new ErrorHttp(422, 'UUID_INVALIDO', 'El lead debe tener un uuid válido.');
        const { empresa, contacto, valor, etapa } = validarLead(req.body);

        // Si el lead ya existe con ese uuid (se creó antes), no se duplica: se devuelve el existente.
        const existente = await cliente.query('SELECT id, vendedor_id FROM leads WHERE uuid = $1', [req.body.uuid]);
        if (existente.rowCount > 0) {
            if (existente.rows[0].vendedor_id !== req.usuario.id) {
                throw new ErrorHttp(409, 'UUID_EN_USO', 'Ya existe otro lead con ese identificador.');
            }
            return { status: 200, cuerpo: { dato: aDto(await buscarLead(cliente, existente.rows[0].id)) } };
        }

        const r = await cliente.query(
            `INSERT INTO leads (uuid, empresa, contacto, valor_potencial, etapa, vendedor_id)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [req.body.uuid, empresa, contacto, valor, etapa, req.usuario.id]
        );
        return { status: 201, cuerpo: { dato: aDto(await buscarLead(cliente, r.rows[0].id)) } };
    })
);

router.put('/:id', permitirRoles(ROL_VENDEDOR, ROL_SUPERVISOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'lead', 'ACTUALIZAR', async (cliente) => {
        const actual = await buscarLead(cliente, req.params.id, true);
        if (!actual) throw new ErrorHttp(404, 'NO_ENCONTRADO', 'El lead no existe en el servidor.');
        if (actual.eliminado) {
            throw new ErrorHttp(409, 'ELIMINADO', 'El supervisor descartó este lead; ya no se puede modificar.', { actual: aDto(actual) });
        }
        if (req.usuario.rol === ROL_VENDEDOR && actual.vendedor_id !== req.usuario.id) {
            throw new ErrorHttp(409, 'REASIGNADO', `Este lead fue reasignado a ${actual.vendedor_nombre}; ya no puedes modificarlo.`, { actual: aDto(actual) });
        }
        // CONTROL DE CONFLICTOS: la app envía la versión que tenía cuando hizo el cambio.
        const versionCliente = Number(req.body.version);
        if (versionCliente !== actual.version) {
            throw new ErrorHttp(409, 'CONFLICTO_VERSION',
                `Otro usuario modificó este lead (versión del servidor ${actual.version}, tu cambio partía de la versión ${req.body.version}).`,
                { actual: aDto(actual) });
        }

        const { empresa, contacto, valor, etapa } = validarLead(req.body);

        // Solo el supervisor puede reasignar el lead a otro vendedor.
        let vendedorId = actual.vendedor_id;
        if (req.usuario.rol === ROL_SUPERVISOR && req.body.vendedorId != null) {
            const v = await cliente.query(
                'SELECT id FROM usuarios WHERE id = $1 AND rol = $2 AND activo = TRUE',
                [req.body.vendedorId, ROL_VENDEDOR]
            );
            if (v.rowCount === 0) throw new ErrorHttp(422, 'VENDEDOR_INVALIDO', 'El vendedor elegido no existe o no está activo.');
            vendedorId = v.rows[0].id;
        }

        await cliente.query(
            `UPDATE leads SET empresa = $2, contacto = $3, valor_potencial = $4, etapa = $5, vendedor_id = $6,
                    version = version + 1, actualizado_en = now()
             WHERE id = $1`,
            [actual.id, empresa, contacto, valor, etapa, vendedorId]
        );
        return { status: 200, cuerpo: { dato: aDto(await buscarLead(cliente, actual.id)) } };
    })
);

router.delete('/:id', permitirRoles(ROL_SUPERVISOR), (req, res, next) =>
    ejecutarOperacion(req, res, next, 'lead', 'ELIMINAR', async (cliente) => {
        const actual = await buscarLead(cliente, req.params.id, true);
        if (!actual) throw new ErrorHttp(404, 'NO_ENCONTRADO', 'El lead no existe en el servidor.');
        if (actual.eliminado) return { status: 200, cuerpo: { dato: aDto(actual) } }; // ya estaba eliminado

        if (req.query.version != null && Number(req.query.version) !== actual.version) {
            throw new ErrorHttp(409, 'CONFLICTO_VERSION',
                `El lead cambió desde que lo viste (versión del servidor ${actual.version}). Revísalo antes de eliminarlo.`,
                { actual: aDto(actual) });
        }

        // Borrado lógico del lead y de sus tareas e interacciones.
        await cliente.query('UPDATE leads SET eliminado = TRUE, version = version + 1, actualizado_en = now() WHERE id = $1', [actual.id]);
        await cliente.query('UPDATE tareas SET eliminado = TRUE, version = version + 1, actualizado_en = now() WHERE lead_id = $1', [actual.id]);
        await cliente.query('UPDATE interacciones SET eliminado = TRUE, version = version + 1, actualizado_en = now() WHERE lead_id = $1', [actual.id]);
        return { status: 200, cuerpo: { dato: aDto(await buscarLead(cliente, actual.id)) } };
    })
);

module.exports = router;
