// Conexión a la base de datos remota (PostgreSQL en Neon) mediante un pool de conexiones.
const { Pool } = require('pg');

let pool = null;

function obtenerPool() {
    if (!pool) {
        if (!process.env.DATABASE_URL) {
            throw new Error('Falta DATABASE_URL en el archivo .env (connection string de Neon).');
        }
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }, // Neon exige conexión cifrada (SSL)
            max: 5
        });
    }
    return pool;
}

// Permite reemplazar el pool (se usa en las pruebas locales).
function usarPool(nuevoPool) {
    pool = nuevoPool;
}

// Consulta simple: query('SELECT ... WHERE id = $1', [id])
async function query(texto, parametros) {
    return obtenerPool().query(texto, parametros);
}

// Ejecuta varias consultas dentro de UNA transacción: si algo falla, se deshace todo.
async function transaccion(funcion) {
    const cliente = await obtenerPool().connect();
    try {
        await cliente.query('BEGIN');
        const resultado = await funcion(cliente);
        await cliente.query('COMMIT');
        return resultado;
    } catch (error) {
        await cliente.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        cliente.release();
    }
}

module.exports = { query, transaccion, obtenerPool, usarPool };
