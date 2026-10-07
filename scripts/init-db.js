// Crea las tablas (db/schema.sql) y carga los datos de prueba (db/seed.sql) en Neon.
// Uso: npm run init-db        ¡OJO! Borra los datos que haya y deja la BD como nueva.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { obtenerPool } = require('../src/db');

async function main() {
    const pool = obtenerPool();
    const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    const seed = fs.readFileSync(path.join(__dirname, '..', 'db', 'seed.sql'), 'utf8');

    console.log('Creando tablas...');
    await pool.query(schema);
    console.log('Cargando datos de prueba...');
    await pool.query(seed);

    const r = await pool.query(`SELECT
        (SELECT count(*) FROM usuarios)::int AS usuarios,
        (SELECT count(*) FROM leads)::int AS leads,
        (SELECT count(*) FROM tareas)::int AS tareas,
        (SELECT count(*) FROM interacciones)::int AS interacciones`);
    console.log('✔ Base de datos lista:', r.rows[0]);
    await pool.end();
}

main().catch((error) => {
    console.error('✖ Error al inicializar la base de datos:', error.message);
    process.exit(1);
});
