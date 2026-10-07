// IDEMPOTENCIA: toda escritura (POST, PUT, DELETE) viene con la cabecera X-Operacion-UUID.
// - Si ese UUID ya se procesó, se devuelve la MISMA respuesta guardada y no se repite nada
//   (así un reintento o un reenvío desde el celular nunca crea duplicados).
// - Si es nuevo, se ejecuta la lógica y se guarda el resultado en operaciones_procesadas,
//   todo dentro de una sola transacción.
const { obtenerPool } = require('./db');
const { ErrorHttp, esUuid } = require('./errores');

async function ejecutarOperacion(req, res, next, entidad, tipoOperacion, logica) {
    const uuidOperacion = req.get('X-Operacion-UUID');
    if (!esUuid(uuidOperacion)) {
        return res.status(400).json({
            error: 'FALTA_UUID_OPERACION',
            mensaje: 'Cada escritura debe enviar la cabecera X-Operacion-UUID con un UUID válido.'
        });
    }

    const cliente = await obtenerPool().connect();
    try {
        await cliente.query('BEGIN');

        // 1) Se "reserva" el UUID de la operación. Si ya existía, es un DUPLICADO.
        const reserva = await cliente.query(
            `INSERT INTO operaciones_procesadas (uuid_operacion, usuario_id, entidad, tipo_operacion)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (uuid_operacion) DO NOTHING
             RETURNING uuid_operacion`,
            [uuidOperacion, req.usuario.id, entidad, tipoOperacion]
        );

        if (reserva.rowCount === 0) {
            const previa = await cliente.query(
                'SELECT codigo_http, respuesta FROM operaciones_procesadas WHERE uuid_operacion = $1',
                [uuidOperacion]
            );
            await cliente.query('COMMIT');
            const fila = previa.rows[0];
            res.set('X-Operacion-Duplicada', 'true');
            return res.status(fila.codigo_http || 200).json({ ...(fila.respuesta || {}), duplicada: true });
        }

        // 2) Se ejecuta la lógica del negocio. Si es rechazada (permiso, conflicto, validación),
        //    se deshacen sus cambios pero se guarda el rechazo para responder igual en un reenvío.
        await cliente.query('SAVEPOINT logica');
        let status;
        let cuerpo;
        try {
            ({ status, cuerpo } = await logica(cliente));
        } catch (error) {
            const errorHttp = convertirError(error);
            if (!errorHttp) throw error;
            await cliente.query('ROLLBACK TO SAVEPOINT logica');
            status = errorHttp.status;
            cuerpo = errorHttp.cuerpo();
        }

        await cliente.query(
            'UPDATE operaciones_procesadas SET codigo_http = $2, respuesta = $3 WHERE uuid_operacion = $1',
            [uuidOperacion, status, JSON.stringify(cuerpo)]
        );
        await cliente.query('COMMIT');

        res.set('X-Operacion-Duplicada', 'false');
        return res.status(status).json({ ...cuerpo, duplicada: false });
    } catch (error) {
        await cliente.query('ROLLBACK').catch(() => {});
        return next(error);
    } finally {
        cliente.release();
    }
}

// Convierte errores de validación de PostgreSQL (CHECK, FK, NOT NULL) en respuestas 422.
function convertirError(error) {
    if (error instanceof ErrorHttp) return error;
    if (error && typeof error.code === 'string' && error.code.startsWith('23')) {
        return new ErrorHttp(422, 'DATOS_INVALIDOS', 'Los datos no cumplen las reglas de la base de datos: ' + (error.detail || error.message));
    }
    return null;
}

module.exports = { ejecutarOperacion };
