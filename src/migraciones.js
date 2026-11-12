// Aplica las migraciones pendientes de db/migraciones/ (en orden) al iniciar la API.
// Cada archivo se registra en schema_migraciones y no se vuelve a ejecutar.
// Así, al hacer "npm start", la base de Neon queda al día sin pasos manuales.
const fs = require('fs');
const path = require('path');
const { obtenerPool } = require('./db');

const CARPETA = path.join(__dirname, '..', 'db', 'migraciones');

async function aplicarMigraciones({ log = console.log } = {}) {
    const pool = obtenerPool();
    // Si la base está vacía, primero se crea el esquema del parcial con sus datos de prueba
    const existe = await pool.query("SELECT to_regclass('public.leads') IS NOT NULL AS hay");
    if (!existe.rows[0].hay) {
        log('  Base vacía: creando el esquema y los datos del parcial...');
        await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
        await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'seed.sql'), 'utf8'));
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migraciones (
        archivo VARCHAR(80) PRIMARY KEY, aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const hechas = new Set((await pool.query('SELECT archivo FROM schema_migraciones')).rows.map(r => r.archivo));
    const pendientes = fs.readdirSync(CARPETA).filter(f => f.endsWith('.sql') && !hechas.has(f)).sort();
    for (const archivo of pendientes) {
        log(`  Aplicando migración ${archivo}...`);
        await pool.query(fs.readFileSync(path.join(CARPETA, archivo), 'utf8'));
        await pool.query('INSERT INTO schema_migraciones (archivo) VALUES ($1) ON CONFLICT DO NOTHING', [archivo]);
    }
    return pendientes;
}

module.exports = { aplicarMigraciones };

// npm run migrar
if (require.main === module) {
    require('dotenv').config();
    aplicarMigraciones()
        .then(p => { console.log(p.length ? `✔ ${p.length} migración(es) aplicada(s).` : '✔ La base ya estaba al día.'); return obtenerPool().end(); })
        .catch(e => { console.error('✖ Error en la migración:', e.message); process.exit(1); });
}
