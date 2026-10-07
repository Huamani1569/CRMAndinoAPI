-- =====================================================================
-- CRM Andino Perú — DATOS INICIALES (ficticios) para la demostración.
-- ¡OJO! Borra todo lo que haya en las tablas y vuelve a cargar los datos de prueba.
-- Cuentas (contraseñas guardadas como hash bcrypt):
--   Vendedores : carlos@crmandino.pe, lucia@crmandino.pe, diego@crmandino.pe, valeria@crmandino.pe  / vendedor123
--   Supervisor : supervisor@crmandino.pe / super123
-- =====================================================================
TRUNCATE operaciones_procesadas, interacciones, tareas, leads, usuarios RESTART IDENTITY CASCADE;

INSERT INTO usuarios (nombre, correo, clave_hash, rol) VALUES
  ('Carlos Mendoza Ríos', 'carlos@crmandino.pe', '$2a$10$ZMRgyk9onukvxaa2UDXK2u/1DOOpZf.6j1RrC.aYAOxLPwpt6vlE2', 'cliente'),
  ('Lucía Quispe Huamán', 'lucia@crmandino.pe', '$2a$10$QQtfgrHqiVyLATvVytX6CuSXeRSGu4KFi3jFLwObgbeyr/9ypoKO2', 'cliente'),
  ('Diego Salazar Torres', 'diego@crmandino.pe', '$2a$10$41Wa4gGUNHyeMmssIquos.nla9E7je9jDsCIrzYw7Tn6FUSXdjg/y', 'cliente'),
  ('Valeria Paredes Luna', 'valeria@crmandino.pe', '$2a$10$/pr77fn53nA68id9N9/qyO20WRIGg3aHT/dysm84YbIDfFbzWmcAC', 'cliente'),
  ('Rosa Villanueva Campos', 'supervisor@crmandino.pe', '$2a$10$gYX79HEYUL4pZ0jzVMjjbu.x5Ts4zcNr7pk6pSwAjQII3.RwM3o9i', 'administrador');

-- 48 leads: 30 de Carlos (la cuenta de demostración del vendedor) y 6 de cada otro vendedor.
INSERT INTO leads (uuid, empresa, contacto, etapa, valor_potencial, vendedor_id)
SELECT gen_random_uuid(), d.empresa, d.contacto, d.etapa, d.valor, u.id
FROM (VALUES
  ('Textiles San Isidro SAC', 'Jorge Ramírez', 'Prospecto', 18500, 'carlos@crmandino.pe'),
  ('Agroexportadora Valle Verde', 'Ana Torres', 'Contactado', 42000, 'carlos@crmandino.pe'),
  ('Constructora Los Andes', 'Miguel Castillo', 'Propuesta', 95000, 'carlos@crmandino.pe'),
  ('Clínica Santa Rosa', 'Patricia Flores', 'Negociación', 67000, 'carlos@crmandino.pe'),
  ('Minera Cordillera Blanca', 'Raúl Gutiérrez', 'Cerrado', 120000, 'carlos@crmandino.pe'),
  ('Distribuidora El Puerto', 'Carmen Vega', 'Prospecto', 23000, 'carlos@crmandino.pe'),
  ('Colegio Nuevo Horizonte', 'Luis Chávez', 'Contactado', 15000, 'carlos@crmandino.pe'),
  ('Panificadora La Espiga', 'Rosa Medina', 'Cerrado', 9800, 'carlos@crmandino.pe'),
  ('Logística Rímac Express', 'Fernando Soto', 'Prospecto', 38000, 'carlos@crmandino.pe'),
  ('Farmacias Salud Total', 'Gabriela Rojas', 'Propuesta', 54000, 'carlos@crmandino.pe'),
  ('Metalmecánica Norte', 'Víctor Huerta', 'Negociación', 76000, 'carlos@crmandino.pe'),
  ('Hotel Costa Pacífico', 'Mariana Díaz', 'Contactado', 27000, 'carlos@crmandino.pe'),
  ('Importadora TecnoPerú', 'Andrés León', 'Cerrado', 61000, 'carlos@crmandino.pe'),
  ('Grifos Continental', 'Sofía Ramos', 'Prospecto', 32000, 'carlos@crmandino.pe'),
  ('Academia Pre San Marcos', 'Óscar Paredes', 'Propuesta', 12500, 'carlos@crmandino.pe'),
  ('Bodegas Pachacámac', 'Elena Vargas', 'Negociación', 45000, 'carlos@crmandino.pe'),
  ('Transportes Sur Andino', 'Julio Cárdenas', 'Prospecto', 58000, 'carlos@crmandino.pe'),
  ('Pesquera Mar de Grau', 'Isabel Núñez', 'Contactado', 88000, 'carlos@crmandino.pe'),
  ('Inmobiliaria Brisas del Sur', 'Ricardo Aguilar', 'Propuesta', 73000, 'carlos@crmandino.pe'),
  ('Veterinaria Mascota Feliz', 'Daniela Ortiz', 'Cerrado', 8500, 'carlos@crmandino.pe'),
  ('Plásticos Industriales Lurín', 'Hugo Benavides', 'Contactado', 49000, 'carlos@crmandino.pe'),
  ('Estudio Contable Ríos', 'Verónica Ríos', 'Prospecto', 14000, 'carlos@crmandino.pe'),
  ('Restaurantes Sabor Criollo', 'Pedro Salinas', 'Negociación', 36000, 'carlos@crmandino.pe'),
  ('Universidad Privada del Este', 'Liliana Campos', 'Propuesta', 110000, 'carlos@crmandino.pe'),
  ('Supermercados Frescomarket', 'Alberto Quispe', 'Contactado', 64000, 'carlos@crmandino.pe'),
  ('Laboratorios BioAndes', 'Natalia Espinoza', 'Negociación', 98000, 'carlos@crmandino.pe'),
  ('Ferretería El Constructor', 'Manuel Huamán', 'Prospecto', 11000, 'carlos@crmandino.pe'),
  ('Courier Rápido Perú', 'Karina Lozano', 'Cerrado', 29000, 'carlos@crmandino.pe'),
  ('Gimnasio Power Fit', 'Renzo Alvarado', 'Contactado', 7500, 'carlos@crmandino.pe'),
  ('Consultora Andina de Proyectos', 'Silvia Mendoza', 'Prospecto', 26000, 'carlos@crmandino.pe'),
  ('Corporación Textil Gamarra', 'Teresa Huamaní', 'Propuesta', 47000, 'lucia@crmandino.pe'),
  ('Agencia de Viajes Inca Trail', 'Jaime Paucar', 'Contactado', 21000, 'lucia@crmandino.pe'),
  ('Lácteos Sierra Verde', 'Martha Condori', 'Negociación', 52000, 'lucia@crmandino.pe'),
  ('Clínica Dental Sonrisas', 'Paola Ventura', 'Prospecto', 9000, 'lucia@crmandino.pe'),
  ('Molinera Los Incas', 'Rubén Apaza', 'Cerrado', 83000, 'lucia@crmandino.pe'),
  ('Seguridad Integral Perú', 'Walter Ccori', 'Propuesta', 39000, 'lucia@crmandino.pe'),
  ('Cementos del Sur Chico', 'Gloria Ascencio', 'Negociación', 105000, 'diego@crmandino.pe'),
  ('Agrícola Valle de Cañete', 'Félix Ramos', 'Prospecto', 34000, 'diego@crmandino.pe'),
  ('Taller Automotriz Lurín', 'Iván Palomino', 'Contactado', 12000, 'diego@crmandino.pe'),
  ('Colegio Bilingüe Pachacámac', 'Rocío Salas', 'Propuesta', 28000, 'diego@crmandino.pe'),
  ('Embotelladora Punta Hermosa', 'César Llanos', 'Cerrado', 57000, 'diego@crmandino.pe'),
  ('Hostal Playa Señoritas', 'Lorena Muñoz', 'Prospecto', 6500, 'diego@crmandino.pe'),
  ('Muebles Ate Vitarte', 'Gonzalo Tapia', 'Contactado', 31000, 'valeria@crmandino.pe'),
  ('Distribuidora Santa Anita', 'Milagros Rivas', 'Negociación', 44000, 'valeria@crmandino.pe'),
  ('Centro Médico La Molina', 'Eduardo Bravo', 'Propuesta', 76000, 'valeria@crmandino.pe'),
  ('Imprenta Gráfica Chaclacayo', 'Pilar Quiroz', 'Prospecto', 8800, 'valeria@crmandino.pe'),
  ('Constructora Cieneguilla', 'Javier Morales', 'Cerrado', 92000, 'valeria@crmandino.pe'),
  ('Lavandería Express Este', 'Susana Aliaga', 'Contactado', 5600, 'valeria@crmandino.pe')
) AS d(empresa, contacto, etapa, valor, correo)
JOIN usuarios u ON u.correo = d.correo;

INSERT INTO tareas (uuid, lead_id, descripcion, fecha_limite, completada)
SELECT gen_random_uuid(), l.id, d.descripcion, d.fecha::date, d.completada
FROM (VALUES
  ('Textiles San Isidro SAC', 'Llamar para presentar la propuesta inicial', '2026-10-08', false),
  ('Constructora Los Andes', 'Enviar cotización actualizada', '2026-10-09', false),
  ('Clínica Santa Rosa', 'Reunión para cerrar condiciones', '2026-10-10', false),
  ('Colegio Nuevo Horizonte', 'Enviar brochure del CRM', '2026-10-12', false),
  ('Farmacias Salud Total', 'Presentar demo al área de TI', '2026-10-08', false),
  ('Metalmecánica Norte', 'Negociar descuento por volumen', '2026-10-11', false),
  ('Logística Rímac Express', 'Primer contacto telefónico', '2026-10-13', false),
  ('Bodegas Pachacámac', 'Revisar contrato con gerencia', '2026-10-07', false),
  ('Universidad Privada del Este', 'Presentación al directorio', '2026-10-09', false),
  ('Minera Cordillera Blanca', 'Encuesta de satisfacción post-venta', '2026-10-01', true),
  ('Corporación Textil Gamarra', 'Enviar propuesta económica', '2026-10-10', false),
  ('Lácteos Sierra Verde', 'Visita a la planta principal', '2026-10-14', false),
  ('Cementos del Sur Chico', 'Confirmar términos de pago', '2026-10-09', false),
  ('Colegio Bilingüe Pachacámac', 'Llamada de seguimiento', '2026-10-15', false),
  ('Distribuidora Santa Anita', 'Negociar plazo de implementación', '2026-10-11', false),
  ('Centro Médico La Molina', 'Demo del módulo de reportes', '2026-10-16', false)
) AS d(empresa, descripcion, fecha, completada)
JOIN leads l ON l.empresa = d.empresa;

INSERT INTO interacciones (uuid, lead_id, tipo, fecha, nota, registrado_por)
SELECT gen_random_uuid(), l.id, d.tipo, d.fecha::date, d.nota, u.id
FROM (VALUES
  ('Constructora Los Andes', 'Llamada', '2026-09-10', 'Primer contacto, interesado en módulo de ventas.', 'carlos@crmandino.pe'),
  ('Constructora Los Andes', 'Reunión', '2026-09-15', 'Demo presencial con el equipo de proyectos.', 'carlos@crmandino.pe'),
  ('Constructora Los Andes', 'Correo', '2026-09-18', 'Envío de propuesta técnica y económica.', 'carlos@crmandino.pe'),
  ('Clínica Santa Rosa', 'Reunión', '2026-09-12', 'Revisión de requerimientos con administración.', 'carlos@crmandino.pe'),
  ('Clínica Santa Rosa', 'Llamada', '2026-09-19', 'Solicitan descuento por pago anual.', 'carlos@crmandino.pe'),
  ('Metalmecánica Norte', 'Correo', '2026-09-14', 'Envío de casos de éxito del sector industria.', 'carlos@crmandino.pe'),
  ('Metalmecánica Norte', 'Reunión', '2026-09-20', 'Negociación de licencias para 25 usuarios.', 'carlos@crmandino.pe'),
  ('Bodegas Pachacámac', 'Llamada', '2026-09-17', 'Confirman presupuesto aprobado.', 'carlos@crmandino.pe'),
  ('Universidad Privada del Este', 'Reunión', '2026-09-16', 'Presentación al área de TI.', 'carlos@crmandino.pe'),
  ('Laboratorios BioAndes', 'Correo', '2026-09-21', 'Envío de contrato borrador.', 'carlos@crmandino.pe'),
  ('Lácteos Sierra Verde', 'Llamada', '2026-09-22', 'Interesados en integración con su ERP.', 'lucia@crmandino.pe'),
  ('Cementos del Sur Chico', 'Reunión', '2026-09-23', 'Reunión con gerencia comercial.', 'diego@crmandino.pe')
) AS d(empresa, tipo, fecha, nota, correo)
JOIN leads l ON l.empresa = d.empresa
JOIN usuarios u ON u.correo = d.correo;
