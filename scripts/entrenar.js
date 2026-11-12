// npm run entrenar → reentrena los 4 modelos de ML y muestra sus métricas
require('dotenv').config();
const { entrenarTodo } = require('../src/ml');
const { obtenerPool } = require('../src/db');
entrenarTodo().then(r => { console.log(JSON.stringify(r, null, 2)); return obtenerPool().end(); })
    .catch(e => { console.error('✖', e.message); process.exit(1); });
