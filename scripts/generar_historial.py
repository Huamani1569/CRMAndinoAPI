"""
Genera db/migraciones/004_historial_simulado.sql: un año de historia FICTICIA del CRM Andino
(leads cerrados, clientes, compras, tickets, campañas y visitas) para que la CRM analítica
y los modelos de ML de la Semana 14 tengan datos con qué trabajar.

Los datos se generan con reglas conocidas (por ejemplo, más interacciones => más
probabilidad de ganar) para que el modelo tenga algo real que aprender. Semilla fija:
siempre se genera el mismo archivo.

Uso:  python scripts/generar_historial.py
"""
import math
import random
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

random.seed(2026)
LIMA = timezone(timedelta(hours=-5))
FIN = datetime(2026, 10, 31, 18, 0, tzinfo=LIMA)          # la historia llega hasta fines de octubre
INICIO = datetime(2025, 11, 1, 9, 0, tzinfo=LIMA)

VENDEDORES = ['carlos@crmandino.pe', 'lucia@crmandino.pe', 'diego@crmandino.pe', 'valeria@crmandino.pe']
AGENTES = ['sofia@crmandino.pe', 'marco@crmandino.pe']
SUPERVISOR = 'supervisor@crmandino.pe'
PRECIOS = {'FAC-01': 1900, 'INV-01': 3200, 'PLA-01': 2800, 'CRM-01': 1500, 'SOP-01': 2400, 'IMP-01': 4500, 'CAP-01': 1990}
DISTRITOS = ['Huancayo', 'El Tambo', 'Chilca', 'Concepción', 'Jauja', 'Pilcomayo']

RUBROS = ['Ferretería', 'Bodega', 'Distribuidora', 'Textiles', 'Clínica', 'Colegio', 'Transportes', 'Panadería',
          'Farmacia', 'Constructora', 'Librería', 'Agroindustrias', 'Restaurante', 'Hostal', 'Inversiones',
          'Comercial', 'Importaciones', 'Lácteos', 'Minimarket', 'Servicios Técnicos']
NOMBRES = ['Mantaro', 'Wanka', 'Los Andes', 'San Carlos', 'Huaytapallana', 'Santa Rosa', 'El Valle', 'Real Plaza',
           'Junín', 'Sicaya', 'Cajas', 'Orcotuna', 'Ocopa', 'Pariahuanca', 'Sapallanga', 'Torre Torre', 'Chupaca',
           'Ingenio', 'Andina', 'Huari', 'Pucará', 'Sincos', 'Viques', 'Huancán', 'Hualhuas', 'Cochas']
PERSONAS = ['Ana Rojas', 'Luis Ccanto', 'María Huamán', 'Jorge Poma', 'Elena Quispe', 'Raúl Meza', 'Pilar Ñaupari',
            'César Cóndor', 'Rocío Arana', 'Iván Taipe', 'Sonia Lazo', 'Hugo Rivera', 'Karina Soto', 'Edgar Vilca',
            'Nadia Ponce', 'Óscar Baltazar', 'Gladys Orihuela', 'Walter Yupanqui', 'Diana Cerrón', 'Pedro Inga']
MOTIVOS_PERDIDA = ['Eligió otra empresa', 'Precio fuera de presupuesto', 'Postergó la compra', 'No respondió más']
DESC_TICKETS = {
    'FACTURACION': ['No se envían las boletas a SUNAT desde la tarde de ayer', 'La factura sale con el IGV mal calculado en un ítem',
                    'No puedo anular una factura emitida por error esta mañana'],
    'ACCESO': ['Un usuario nuevo no puede ingresar al sistema con su clave', 'Se bloqueó la cuenta del administrador de la tienda'],
    'ERROR_SISTEMA': ['El reporte de ventas del mes se queda cargando y no abre', 'Al guardar un producto aparece un error inesperado'],
    'CAPACITACION': ['Necesitamos una capacitación para dos cajeras nuevas', 'Queremos aprender a usar el módulo de inventario'],
    'OTRO': ['Consulta sobre la renovación anual de nuestras licencias'],
}

sql = []
usados_ruc = set()
rnd = random.random


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


def ts(d):
    return q(d.isoformat())


def uid():
    return str(uuid.UUID(int=random.getrandbits(128), version=4))


def ruc():
    while True:
        r = '20' + str(random.randint(100000000, 699999999))
        if r not in usados_ruc and r != '20612345671':
            usados_ruc.add(r)
            return r


def empresa():
    return f'{random.choice(RUBROS)} {random.choice(NOMBRES)} {random.choice(["SAC", "EIRL", "SRL", "SA"])}'


def coord():
    return round(-12.068 + random.uniform(-0.03, 0.03), 6), round(-75.21 + random.uniform(-0.03, 0.03), 6)


def sig(x):
    return 1 / (1 + math.exp(-x))


def antes(d, maxd=FIN):
    return min(d, maxd)


# ------------------------------------------------------------------ estructuras
leads, interacciones, historial, visitas = [], [], [], []
clientes, cotizaciones, detalles, tickets, usuarios_cli = [], [], [], [], []
campanas, respuestas = [], []
cont = {'SOL': 9000, 'COT': 9000, 'SRV': 9000}


def numero(pref, fecha):
    cont[pref] += 1
    return f'{pref}-{fecha.year}-{cont[pref]}'


def nuevo_lead(vendedor, creado, canal, valor, empresa_n, contacto, campana=None, cliente_ruc=None, es_upsell=False, forzar=None):
    """Simula la vida de un lead hasta que se gana o se pierde."""
    etapa_max = random.choices([0, 1, 2, 3], weights=[1, 3, 4, 4])[0]
    n_int = max(0, int(random.gauss(2 + etapa_max * 1.3, 1.6)))
    n_vis = random.choices([0, 1, 2, 3], weights=[5, 3, 1.5, 0.5])[0] if etapa_max >= 1 else 0
    dias_sin = random.choice([random.uniform(0, 6), random.uniform(0, 15), random.uniform(5, 40)])
    z = (-2.4 + 0.85 * etapa_max + 0.20 * n_int + 0.40 * n_vis - 0.075 * dias_sin
         + (0.7 if canal == 'PORTAL' else 0) + (0.35 if canal == 'CAMPANA' else 0)
         - 0.25 * math.log(valor / 10000) + (0.6 if es_upsell else 0) + random.gauss(0, 0.6))
    gana = rnd() < sig(z) if forzar is None else forzar
    duracion = random.uniform(8, 55) + dias_sin
    cierre = antes(creado + timedelta(days=duracion))
    if cierre <= creado + timedelta(days=2):
        cierre = creado + timedelta(days=3)
    lat, lon = coord()
    l = dict(uuid=uid(), empresa=empresa_n, contacto=contacto, vendedor=vendedor, canal=canal, valor=round(valor, 2),
             etapa='GANADO' if gana else 'PERDIDO', creado=creado, cierre=cierre, campana=campana, ruc=cliente_ruc,
             motivo=None if gana else random.choice(MOTIVOS_PERDIDA), lat=lat, lon=lon,
             codigo=numero('SOL', creado) if canal == 'PORTAL' else None, telefono='9' + str(random.randint(10000000, 99999999)))
    leads.append(l)
    # Interacciones antes del cierre, dejando "dias_sin" sin contacto al final
    ultimo = cierre - timedelta(days=dias_sin)
    if ultimo <= creado:
        ultimo = creado + timedelta(hours=2)
    for k in range(n_int):
        f = creado + (ultimo - creado) * ((k + 1) / max(n_int, 1)) - timedelta(hours=random.uniform(0, 5))
        tipo = random.choices(['Llamada', 'WhatsApp', 'Correo', 'Reunión', 'Visita'], weights=[4, 4, 2, 1.5, 1])[0]
        interacciones.append(dict(uuid=uid(), lead=l['uuid'], tipo=tipo, fecha=f, vendedor=vendedor,
                                  resultado=random.choice(['CONTESTO', 'INTERESADO', 'NO_CONTESTO']),
                                  nota='Reunión de presentación del sistema' if tipo == 'Reunión' else ''))
    for k in range(n_vis):
        f = creado + (ultimo - creado) * random.uniform(0.2, 1)
        d = round(random.uniform(5, 260), 1)
        visitas.append(dict(uuid=uid(), lead=l['uuid'], vendedor=vendedor, fecha=f, lat=round(lat + random.uniform(-0.001, 0.001), 6),
                            lon=round(lon + random.uniform(-0.001, 0.001), 6), dist=d))
    # Historial de etapas: NUEVO -> ... -> etapa_max -> GANADO/PERDIDO
    etapas = ['NUEVO', 'CONTACTADO', 'CALIFICADO', 'COTIZADO']
    paso = (cierre - creado) / (etapa_max + 2)
    for k in range(etapa_max):
        historial.append(dict(lead=l['uuid'], a=etapas[k], n=etapas[k + 1], fecha=creado + paso * (k + 1), vendedor=vendedor))
    historial.append(dict(lead=l['uuid'], a=etapas[etapa_max], n=l['etapa'], fecha=cierre, vendedor=vendedor))
    l['etapa_max'] = etapa_max
    return l


def cotizar(l, productos, fecha_envio, estado, motivo=None):
    desc = random.choice([0, 0, 5, 8, 10, 12, 15]) if estado != 'RECHAZADA' else random.choice([0, 5, 8])
    c = dict(uuid=uid(), numero=numero('COT', fecha_envio), lead=l['uuid'], vendedor=l['vendedor'], desc=desc, estado=estado,
             enviada=fecha_envio, vigencia=(fecha_envio + timedelta(days=15)).date(),
             respondida=antes(fecha_envio + timedelta(days=random.uniform(1, 9))), motivo=motivo)
    cotizaciones.append(c)
    for cod, cant in productos:
        detalles.append(dict(cot=c['uuid'], cod=cod, cant=cant))
    return c


def canasta(tiene):
    """Qué compra el cliente: reglas de venta cruzada que luego aprende el modelo Apriori."""
    if not tiene:
        cesta = [('FAC-01', random.randint(2, 8))]
        if rnd() < 0.40: cesta.append(('CAP-01', random.randint(1, 2)))
        if rnd() < 0.30: cesta.append(('IMP-01', 1))
        if rnd() < 0.10: cesta = [('CRM-01', random.randint(2, 5))]
        return cesta
    opciones = []
    if 'FAC-01' in tiene and 'INV-01' not in tiene and rnd() < 0.60: opciones.append(('INV-01', 1))
    if 'FAC-01' in tiene and 'SOP-01' not in tiene and rnd() < 0.35: opciones.append(('SOP-01', 1))
    if 'INV-01' in tiene and 'PLA-01' not in tiene and rnd() < 0.45: opciones.append(('PLA-01', 1))
    if 'CRM-01' not in tiene and rnd() < 0.15: opciones.append(('CRM-01', random.randint(2, 4)))
    if not opciones: opciones.append(('FAC-01', random.randint(1, 3)))   # más usuarios
    if rnd() < 0.25: opciones.append(('CAP-01', 1))
    return opciones


def valor_de(cesta):
    return sum(PRECIOS[c] * n for c, n in cesta)


# ------------------------------------------------------------------ campañas históricas
for nombre, oferta, cod, desc, fecha in [
    ('Inventario de invierno', 'Módulo Inventario con 15 % de descuento', 'INV-01', 15, datetime(2026, 6, 10, 9, tzinfo=LIMA)),
    ('Soporte prioritario', 'Soporte anual con 2 meses gratis', 'SOP-01', 10, datetime(2026, 8, 5, 9, tzinfo=LIMA)),
    ('Planillas sin errores', 'Módulo Planillas con 10 % de descuento', 'PLA-01', 10, datetime(2026, 10, 1, 9, tzinfo=LIMA)),
]:
    campanas.append(dict(nombre=nombre, oferta=oferta, cod=cod, desc=desc, inicio=fecha.date(), fin=(fecha + timedelta(days=30)).date()))

# ------------------------------------------------------------------ leads de nuevos negocios y sus clientes
for i in range(210):
    creado = INICIO + timedelta(days=random.uniform(0, 340), hours=random.uniform(0, 8))
    vendedor = random.choices(VENDEDORES, weights=[4, 3, 3, 2])[0]
    canal = random.choices(['VENDEDOR', 'PORTAL'], weights=[6.5, 3.5])[0]
    cesta = canasta(set())
    l = nuevo_lead(vendedor, creado, canal, valor_de(cesta) * random.uniform(0.85, 1.25), empresa(), random.choice(PERSONAS))
    if l['etapa'] == 'GANADO':
        r = ruc()
        l['ruc'] = r
        cli = dict(ruc=r, razon=l['empresa'], vendedor=vendedor, alta=l['cierre'].date(), distrito=random.choice(DISTRITOS),
                   lat=l['lat'], lon=l['lon'], tiene=set(), compras=[], tickets=0, csat=[], email=f'contacto{r[-6:]}@demo.crmandino.pe',
                   contacto=l['contacto'], lealtad=random.gauss(0, 1), acepta=rnd() > 0.08)
        clientes.append(cli)
        l['cliente'] = r
        cotizar(l, cesta, l['cierre'] - timedelta(days=random.uniform(2, 7)), 'ACEPTADA')
        cli['tiene'] |= {c for c, _ in cesta}
        cli['compras'].append(l['cierre'])
    elif l['etapa_max'] == 3:
        cotizar(l, cesta, l['cierre'] - timedelta(days=random.uniform(3, 9)), 'RECHAZADA',
                random.choice(['PRECIO', 'PLAZO', 'OTRA_EMPRESA', 'OTRO']))

# ------------------------------------------------------------------ la cuenta de demostración del Portal (Ferretería El Tambo)
_alta = datetime(2024, 3, 18, 10, tzinfo=LIMA)
_cesta = [('FAC-01', 5), ('CAP-01', 1)]
_l = nuevo_lead('carlos@crmandino.pe', _alta - timedelta(days=20), 'VENDEDOR', valor_de(_cesta), 'Ferretería El Tambo SAC', 'Rosa Quispe', forzar=True)
_l['ruc'] = _l['cliente'] = '20612345671'
cotizar(_l, _cesta, _l['cierre'] - timedelta(days=3), 'ACEPTADA')
for _f, _c in [(datetime(2025, 2, 10, 11, tzinfo=LIMA), [('SOP-01', 1)]), (datetime(2025, 9, 3, 16, tzinfo=LIMA), [('FAC-01', 2)])]:
    _u = nuevo_lead('carlos@crmandino.pe', _f, 'VENDEDOR', valor_de(_c), 'Ferretería El Tambo SAC', 'Rosa Quispe', es_upsell=True, forzar=True)
    _u['ruc'] = _u['cliente'] = '20612345671'
    cotizar(_u, _c, _u['cierre'] - timedelta(days=2), 'ACEPTADA')
for _f, _cal in [(datetime(2025, 6, 2, 10, tzinfo=LIMA), 5), (datetime(2026, 7, 21, 9, tzinfo=LIMA), 5)]:
    tickets.append(dict(uuid=uid(), numero=numero('SRV', _f), ruc='20612345671', cat='ACCESO', desc='Un usuario nuevo no puede ingresar al sistema con su clave',
                        puntaje=84, prio='ALTA', agente=AGENTES[0], creado=_f, resuelta=_f + timedelta(hours=1.5), sla=_f + timedelta(hours=4), calif=_cal))

# ------------------------------------------------------------------ vida de cada cliente: compras, tickets y cancelación
for cli in clientes:
    f = datetime.combine(cli['alta'], datetime.min.time(), LIMA)
    malo = cli['lealtad'] < -0.55         # clientes que terminarán yéndose
    fin_vida = FIN
    if malo and (FIN - f).days > 170:
        fin_vida = f + timedelta(days=random.uniform(120, max(130, (FIN - f).days - 60)))
    # tickets a lo largo de la vida
    t = f + timedelta(days=random.uniform(10, 60))
    while t < fin_vida:
        cat = random.choices(list(DESC_TICKETS), weights=[4, 2, 2, 1.5, 0.5])[0]
        puntaje = max(15, min(98, int(random.gauss(72 if not malo else 45, 14))))
        prio = 'ALTA' if puntaje >= 70 else 'NORMAL'
        horas = random.uniform(0.5, 3.5) if prio == 'ALTA' else random.uniform(2, 30)
        if malo: horas *= 1.6
        calif = max(1, min(5, round(random.gauss(4.4 if not malo else 2.6, 0.8))))
        tickets.append(dict(uuid=uid(), numero=numero('SRV', t), ruc=cli['ruc'], cat=cat, desc=random.choice(DESC_TICKETS[cat]),
                            puntaje=puntaje, prio=prio, agente=AGENTES[0] if prio == 'ALTA' else random.choice(AGENTES),
                            creado=t, resuelta=t + timedelta(hours=horas), sla=t + timedelta(hours=4 if prio == 'ALTA' else 24), calif=calif))
        cli['csat'].append(calif)
        cli['tickets'] += 1
        t += timedelta(days=random.uniform(25, 110) / (1.8 if malo else 1))
    # compras de venta cruzada (leads de "upsell" ganados o perdidos)
    p = f + timedelta(days=random.uniform(40, 120))
    while p < fin_vida - timedelta(days=15):
        if malo and p > fin_vida - timedelta(days=150):
            break                                   # antes de irse deja de comprar
        cesta = canasta(cli['tiene'])
        canal = random.choices(['VENDEDOR', 'CAMPANA'], weights=[7, 3])[0]
        camp = None
        if canal == 'CAMPANA':
            vig = [k for k, c in enumerate(campanas) if c['inicio'] <= p.date() <= c['fin'] + timedelta(days=20)]
            if vig: camp = vig[0]
            else: canal = 'VENDEDOR'
        l = nuevo_lead(cli['vendedor'], p, canal, valor_de(cesta) * random.uniform(0.9, 1.15), cli['razon'], cli['contacto'],
                       campana=camp, cliente_ruc=cli['ruc'], es_upsell=True)
        l['cliente'] = cli['ruc']
        if l['etapa'] == 'GANADO':
            cotizar(l, cesta, l['cierre'] - timedelta(days=random.uniform(1, 6)), 'ACEPTADA')
            cli['tiene'] |= {c for c, _ in cesta}
            cli['compras'].append(l['cierre'])
        p += timedelta(days=random.uniform(60, 160))
    if fin_vida < FIN:
        cli['cancelado'] = fin_vida.date()

# respuestas de campañas: un envío por cliente y canal; tasas distintas por canal (Laudon fig. 9.7)
TASAS = {'PUSH': 0.13, 'WHATSAPP': 0.12, 'CORREO': 0.06, 'LLAMADA': 0.09, 'VISITA': 0.16}
for k, c in enumerate(campanas):
    for cli in clientes:
        alta = datetime.combine(cli['alta'], datetime.min.time(), LIMA).date()
        if not cli['acepta'] or alta > c['inicio'] or (cli.get('cancelado') and cli['cancelado'] < c['inicio']):
            continue
        canales = ['PUSH', 'WHATSAPP', 'CORREO'] + (['LLAMADA'] if rnd() < 0.4 else []) + (['VISITA'] if rnd() < 0.15 else [])
        for can in canales:
            resp = rnd() < TASAS[can]
            respuestas.append(dict(camp=k, ruc=cli['ruc'], canal=can, enviado=c['inicio'],
                                   respondido=(datetime.combine(c['inicio'], datetime.min.time(), LIMA) + timedelta(days=random.uniform(0, 10))) if resp else None))

# ------------------------------------------------------------------ SQL
print_ = sql.append
print_('-- =====================================================================')
print_('-- CRM Andino Perú — Migración 004: UN AÑO DE HISTORIA SIMULADA (datos ficticios)')
print_('-- Generado por scripts/generar_historial.py (semilla fija). No editar a mano.')
print_(f'-- {len(leads)} leads cerrados · {len(clientes)} clientes · {len(cotizaciones)} cotizaciones · '
       f'{len(tickets)} tickets · {len(respuestas)} envíos de campaña')
print_('-- Los RUC tienen formato válido pero son inventados.')
print_('-- =====================================================================')
print_('BEGIN;')
print_("SET LOCAL crm.usuario_id = '';")
print_('ALTER TABLE leads DISABLE TRIGGER trg_reglas_lead;')
print_('ALTER TABLE solicitudes_servicio DISABLE TRIGGER trg_reglas_solicitud;')
print_('ALTER TABLE respuestas_campana DISABLE TRIGGER trg_envio_campana;')

# metas de ventas
print_("INSERT INTO metas_ventas (mes, monto) SELECT to_char(m, 'YYYY-MM'), 200000 FROM generate_series('2025-11-01'::date, '2027-06-01'::date, interval '1 month') m ON CONFLICT DO NOTHING;")

# campañas
vals = ',\n'.join(f"({q(c['nombre'])}, '{{\"sinProducto\":\"{c['cod']}\"}}', {q(c['oferta'])}, '{c['cod']}', {c['desc']}, '{c['inicio']}', '{c['fin']}')" for c in campanas)
print_(f"""INSERT INTO campanas (nombre, segmento, oferta, producto_id, descuento_pct, canales, inicio, fin, estado, creada_por, creado_en)
SELECT v.nombre, v.seg::jsonb, v.oferta, p.id, v.d, ARRAY['PUSH','WHATSAPP','CORREO','LLAMADA','VISITA']::varchar(10)[], v.i::date, v.f::date, 'FINALIZADA',
       (SELECT id FROM usuarios WHERE correo = {q(SUPERVISOR)}), v.i::date
FROM (VALUES {vals}) v(nombre, seg, oferta, cod, d, i, f) JOIN productos p ON p.codigo = v.cod;""")

# clientes
vals = ',\n'.join(
    f"({q(c['ruc'])}, {q(c['razon'])}, {q(c['distrito'])}, {c['lat']}, {c['lon']}, {q(c['vendedor'])}, '{c['alta']}', "
    f"{'NULL' if not c.get('cancelado') else q(c['cancelado'])}, {'TRUE' if c['acepta'] else 'FALSE'})" for c in clientes)
print_(f"""INSERT INTO clientes (ruc, razon_social, distrito, latitud, longitud, vendedor_id, fecha_alta, cancelado_en, acepta_ofertas)
SELECT v.ruc, v.razon, v.distrito, v.lat, v.lon, u.id, v.alta::date, v.cancelado::date, v.acepta
FROM (VALUES {vals}) v(ruc, razon, distrito, lat, lon, correo, alta, cancelado, acepta)
JOIN usuarios u ON u.correo = v.correo
ON CONFLICT (ruc) DO NOTHING;""")

# un usuario del Portal por cliente (contraseña de prueba: cliente123)
print_("""INSERT INTO usuarios (nombre, correo, clave_hash, rol, cliente_id, consentimiento_en)
SELECT 'Contacto ' || c.razon_social, 'contacto' || c.ruc || '@demo.crmandino.pe',
       '$2a$10$co3qBTsyprHJEt8PhramO.fCbw0dm.tljNJY3pYmqSH5U1o8oKY1.', 'cliente', c.id, c.fecha_alta
FROM clientes c WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.cliente_id = c.id)
ON CONFLICT (correo) DO NOTHING;""")


def lote(cabecera, filas, cola, tam=150):
    for i in range(0, len(filas), tam):
        print_(cabecera + ',\n'.join(filas[i:i + tam]) + cola)


# leads
filas = [f"({q(l['uuid'])}, {q(l['empresa'])}, {q(l['contacto'])}, {l['valor']}, {q(l['etapa'])}, {q(l['vendedor'])}, {q(l['canal'])}, "
         f"{q(l['codigo']) if l['codigo'] else 'NULL'}, {q(l['ruc']) if l.get('ruc') else 'NULL'}, {q(l['motivo']) if l['motivo'] else 'NULL'}, "
         f"{q(campanas[l['campana']]['nombre']) if l['campana'] is not None else 'NULL'}, {q(l.get('cliente') or '')}, {ts(l['creado'])}, {ts(l['cierre'])}, "
         f"{l['lat']}, {l['lon']}, {q(l['telefono'])})" for l in leads]
lote("""INSERT INTO leads (uuid, empresa, contacto, valor_potencial, etapa, vendedor_id, canal_origen, codigo_seguimiento, ruc,
                   motivo_perdida, campana_id, cliente_id, creado_en, actualizado_en, ultimo_contacto_en, latitud, longitud, telefono)
SELECT v.uuid::uuid, v.empresa, v.contacto, v.valor, v.etapa, u.id, v.canal, v.codigo, v.ruc, v.motivo,
       (SELECT id FROM campanas WHERE nombre = v.camp ORDER BY id DESC LIMIT 1), c.id, v.creado::timestamptz, v.cierre::timestamptz, v.cierre::timestamptz, v.lat, v.lon, v.tel
FROM (VALUES """, filas, """) v(uuid, empresa, contacto, valor, etapa, correo, canal, codigo, ruc, motivo, camp, cli_ruc, creado, cierre, lat, lon, tel)
JOIN usuarios u ON u.correo = v.correo LEFT JOIN clientes c ON c.ruc = NULLIF(v.cli_ruc, '');""")

# historial
filas = [f"({q(h['lead'])}, {q(h['a'])}, {q(h['n'])}, {ts(h['fecha'])}, {q(h['vendedor'])})" for h in historial]
lote("INSERT INTO historial_lead (lead_id, campo, valor_anterior, valor_nuevo, fecha, usuario_id)\nSELECT l.id, 'ETAPA', v.a, v.n, v.f::timestamptz, u.id FROM (VALUES ",
     filas, ") v(lead, a, n, f, correo) JOIN leads l ON l.uuid = v.lead::uuid JOIN usuarios u ON u.correo = v.correo;")

# interacciones
filas = [f"({q(i['uuid'])}, {q(i['lead'])}, {q(i['tipo'])}, {ts(i['fecha'])}, {q(i['nota'])}, {q(i['resultado'])}, {q(i['vendedor'])})" for i in interacciones]
lote("""INSERT INTO interacciones (uuid, lead_id, tipo, fecha, fecha_hora, nota, resultado, registrado_por, creado_en, actualizado_en)
SELECT v.uuid::uuid, l.id, v.tipo, (v.f::timestamptz AT TIME ZONE 'America/Lima')::date, v.f::timestamptz, v.nota, v.res, u.id, v.f::timestamptz, v.f::timestamptz
FROM (VALUES """, filas, ") v(uuid, lead, tipo, f, nota, res, correo) JOIN leads l ON l.uuid = v.lead::uuid JOIN usuarios u ON u.correo = v.correo;")

# visitas
filas = [f"({q(v['uuid'])}, {q(v['lead'])}, {q(v['vendedor'])}, {ts(v['fecha'])}, {v['lat']}, {v['lon']}, {v['dist']})" for v in visitas]
lote("""INSERT INTO visitas (uuid, lead_id, vendedor_id, fecha_programada, checkin_en, latitud, longitud, precision_m, distancia_m, creado_en, actualizado_en)
SELECT v.uuid::uuid, l.id, u.id, (v.f::timestamptz AT TIME ZONE 'America/Lima')::date, v.f::timestamptz, v.lat, v.lon, 12, v.d, v.f::timestamptz, v.f::timestamptz
FROM (VALUES """, filas, ") v(uuid, lead, correo, f, lat, lon, d) JOIN leads l ON l.uuid = v.lead::uuid JOIN usuarios u ON u.correo = v.correo;")

# cotizaciones (se insertan con subtotal 0; el trigger del detalle calcula el total)
filas = [f"({q(c['uuid'])}, {q(c['numero'])}, {q(c['lead'])}, {q(c['vendedor'])}, {c['desc']}, {q(c['estado'])}, {ts(c['enviada'])}, "
         f"'{c['vigencia']}', {ts(c['respondida'])}, {q(c['motivo']) if c['motivo'] else 'NULL'})" for c in cotizaciones]
lote("""INSERT INTO cotizaciones (uuid, numero, lead_id, vendedor_id, descuento_pct, estado, enviada_en, vigencia_hasta, respondida_en,
                          motivo_rechazo, aprobada_por, creado_en, actualizado_en)
SELECT v.uuid::uuid, v.numero, l.id, u.id, v.d, v.estado, v.env::timestamptz, v.vig::date, v.resp::timestamptz, v.mot,
       CASE WHEN v.d > 10 THEN (SELECT id FROM usuarios WHERE correo = 'supervisor@crmandino.pe') END, v.env::timestamptz, v.resp::timestamptz
FROM (VALUES """, filas, ") v(uuid, numero, lead, correo, d, estado, env, vig, resp, mot) JOIN leads l ON l.uuid = v.lead::uuid JOIN usuarios u ON u.correo = v.correo;")

filas = [f"({q(d['cot'])}, {q(d['cod'])}, {d['cant']})" for d in detalles]
lote("""INSERT INTO cotizacion_detalle (cotizacion_id, producto_id, cantidad, precio_unit)
SELECT c.id, p.id, v.cant, p.precio FROM (VALUES """, filas,
     ") v(cot, cod, cant) JOIN cotizaciones c ON c.uuid = v.cot::uuid JOIN productos p ON p.codigo = v.cod ON CONFLICT DO NOTHING;")

# tickets
filas = [f"({q(t['uuid'])}, {q(t['numero'])}, {q(t['ruc'])}, {q(t['cat'])}, {q(t['desc'])}, {t['puntaje']}, {q(t['prio'])}, {q(t['agente'])}, "
         f"{ts(t['creado'])}, {ts(t['resuelta'])}, {ts(t['sla'])}, {t['calif']})" for t in tickets]
lote("""INSERT INTO solicitudes_servicio (uuid, numero, cliente_id, creada_por, categoria, descripcion, puntaje_cliente, prioridad, agente_id,
                                  estado, sla_hasta, solucion, resuelta_en, cerrada_en, calificacion, calificada_en, creado_en, actualizado_en)
SELECT v.uuid::uuid, v.numero, c.id, (SELECT id FROM usuarios WHERE cliente_id = c.id ORDER BY id LIMIT 1), v.cat, v.descr, v.p, v.prio, a.id,
       'CERRADA', v.sla::timestamptz, 'Caso atendido y verificado con el cliente', v.res::timestamptz, v.res::timestamptz + interval '6 hours',
       v.cal, v.res::timestamptz + interval '7 hours', v.cre::timestamptz, v.res::timestamptz + interval '7 hours'
FROM (VALUES """, filas, ") v(uuid, numero, ruc, cat, descr, p, prio, agente, cre, res, sla, cal) JOIN clientes c ON c.ruc = v.ruc JOIN usuarios a ON a.correo = v.agente;")

# respuestas de campaña
filas = [f"({q(campanas[r['camp']]['nombre'])}, {q(r['ruc'])}, {q(r['canal'])}, '{r['enviado']}', {ts(r['respondido']) if r['respondido'] else 'NULL'})" for r in respuestas]
lote("""INSERT INTO respuestas_campana (campana_id, cliente_id, canal, enviado_en, respondio, respondido_en)
SELECT (SELECT id FROM campanas WHERE nombre = v.camp ORDER BY id DESC LIMIT 1), c.id, v.canal, v.env::date, v.resp IS NOT NULL, v.resp::timestamptz
FROM (VALUES """, filas, ") v(camp, ruc, canal, env, resp) JOIN clientes c ON c.ruc = v.ruc ON CONFLICT DO NOTHING;")

# Tickets abiertos HOY para la demo de la cola del agente (SLA relativo a la hora en que se aplica)
print_("""INSERT INTO solicitudes_servicio (uuid, numero, cliente_id, creada_por, categoria, descripcion, puntaje_cliente, prioridad, agente_id, estado, sla_hasta, creado_en)
SELECT gen_random_uuid(), 'SRV-2026-' || (9800 + x.n), c.id, (SELECT id FROM usuarios WHERE cliente_id = c.id ORDER BY id LIMIT 1), x.cat, x.descr,
       c.puntaje_valor, CASE WHEN c.puntaje_valor >= 70 THEN 'ALTA' ELSE 'NORMAL' END, NULL, 'ABIERTA',
       now() - make_interval(hours => x.h) + CASE WHEN c.puntaje_valor >= 70 THEN interval '4 hours' ELSE interval '24 hours' END,
       now() - make_interval(hours => x.h)
FROM (VALUES (1, 'FACTURACION', 'La factura electrónica sale rechazada por un error de serie', 3),
             (2, 'ACCESO', 'El cajero nuevo no puede iniciar sesión en el punto de venta', 1),
             (3, 'ERROR_SISTEMA', 'El cierre de caja no cuadra con el reporte del día de ayer', 20)) x(n, cat, descr, h)
JOIN LATERAL (SELECT * FROM clientes WHERE puntaje_valor IS NOT NULL AND cancelado_en IS NULL ORDER BY (id * x.n * 7919) % 97 LIMIT 1) c ON TRUE
WHERE NOT EXISTS (SELECT 1 FROM solicitudes_servicio WHERE numero = 'SRV-2026-' || (9800 + x.n));""")

print_('ALTER TABLE leads ENABLE TRIGGER trg_reglas_lead;')
print_('ALTER TABLE solicitudes_servicio ENABLE TRIGGER trg_reglas_solicitud;')
print_('ALTER TABLE respuestas_campana ENABLE TRIGGER trg_envio_campana;')
print_('COMMIT;')

salida = Path(__file__).resolve().parent.parent / 'db' / 'migraciones' / '004_historial_simulado.sql'
salida.write_text('\n'.join(sql) + '\n', encoding='utf-8')
gan = sum(1 for l in leads if l['etapa'] == 'GANADO')
print(f'OK {salida.name}: {len(leads)} leads ({gan} ganados), {len(clientes)} clientes '
      f'({sum(1 for c in clientes if c.get("cancelado"))} cancelados), {len(cotizaciones)} cotizaciones, {len(tickets)} tickets, '
      f'{len(interacciones)} interacciones, {len(visitas)} visitas, {len(respuestas)} envíos')
