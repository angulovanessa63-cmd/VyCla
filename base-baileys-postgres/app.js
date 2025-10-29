const { createBot, createProvider, createFlow, addKeyword, EVENTS, endFlow, gotoFlow } = require('@bot-whatsapp/bot');
const QRPortalWeb = require('@bot-whatsapp/portal');
const BaileysProvider = require('@bot-whatsapp/provider/baileys');
const PostgreSQLAdapter = require('@bot-whatsapp/database/postgres');
const BotManager = require('C:/Proyecto de grado/VyCla-v03/base-baileys-postgres/botManager.js');
const { Client } = require('pg');
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require("fs");
const pdf = require("pdf-parse");
const path = require("path");
const FormData = require("form-data");
const {downloadMediaMessage } = require("@whiskeysockets/baileys");



// Configuración de PostgreSQL
require('dotenv').config();
const POSTGRES_DB_HOST = process.env.POSTGRES_DB_HOST || 'localhost';
const POSTGRES_DB_USER = process.env.POSTGRES_DB_USER || 'postgres';
const POSTGRES_DB_PASSWORD = process.env.POSTGRES_DB_PASSWORD || 'tumaco2025';
const POSTGRES_DB_NAME = process.env.POSTGRES_DB_NAME || 'VyCla01';
const POSTGRES_DB_PORT = process.env.POSTGRES_DB_PORT || '5432';

console.log(`Conectando a PostgreSQL en ${POSTGRES_DB_HOST}:${POSTGRES_DB_PORT}`);

// Conexión a PostgreSQL
const client = new Client({
    host: POSTGRES_DB_HOST,
    user: POSTGRES_DB_USER,
    database: POSTGRES_DB_NAME,
    password: POSTGRES_DB_PASSWORD,
    port: POSTGRES_DB_PORT,
});
client.connect();

// Función para guardar el mensaje en la base de datos
const guardarMensaje = async (numero, mensaje) => {
    const fecha = new Date().toISOString();
    try {
        await client.query(
            'INSERT INTO mensajes (numero, mensaje, fecha) VALUES ($1, $2, $3)',
            [numero, mensaje, fecha]
        );
        console.log(` Mensaje guardado: ${mensaje} (de ${numero})`);
    } catch (error) {
        console.error(' Error al guardar mensaje:', error);
    }
};

//Consulatar en BD si el usuario ya realizó la encuesta
const usuarioYaRealizoEncuesta = async (numero) => {
    try {
        console.log(`Verificando si ${numero} ya completó la encuesta...`);
        
        const result = await client.query(
            `SELECT 1 FROM mensajes 
             WHERE numero = $1 
             AND mensaje LIKE '[ENCUESTA-RECOMENDACION]%' 
             LIMIT 1`,
            [numero]
        );

        const yaCompleto = result.rowCount > 0;
        console.log(` Usuario ${numero} ${yaCompleto ? 'YA completó' : 'NO ha completado'} la encuesta`);
        
        return yaCompleto;
    } catch (error) {
        console.error('Error al verificar encuesta:', error);
        // En caso de error, asumimos que no completó para no bloquear el flujo
        return false;
    }
};


// Consultar la intención con el backend de Python
const consultarIntencion = async (mensaje) => {
    try {
        const respuesta = await axios.post('http://127.0.0.1:5000/chat', { message: mensaje });
        return {
            tag: respuesta.data.tag || "no_entendido",
            responses: [respuesta.data.message],
            action: respuesta.data.action || null,
            capture: respuesta.data.capture || false
        };
    } catch (error) {
        console.error('Error al consultar intención:', error);
        return {
            tag: "no_entendido",
            responses: ["Lo siento, no pude procesar tu mensaje. Intenta de nuevo más tarde."],
            action: null,
            capture: false
        };
    }
};


const globalStates = {};//Variable global para manejar estados
const activeTimeouts = new Map();// Mapa para almacenar los timeouts

//Limpiador de los tiempos con cada interaccion del usuario
const clearUserTimeout = (userId) => {
    if (activeTimeouts.has(userId)) {
        clearTimeout(activeTimeouts.get(userId));
        activeTimeouts.delete(userId);
    }
};

// Función para manejar el timeout
const handleUserTimeout = async (userId) => {
    console.log(`Timeout disparado para ${userId}`);
    
    try {
        const userState = getUserState(userId);
        const nombreUsuario = userState?.nombreUsuario || "Usuario";
        
        // Crear un contexto artificial con el nombre del usuario
        const fakeCtx = {
            from: userId,
            body: '',
            pushName: nombreUsuario
        };
        
        await Encuesta(fakeCtx, { 
            flowDynamic: async (msgs) => {
                // Enviar el mensaje a través del BotManager
                for (const msg of Array.isArray(msgs) ? msgs : [msgs]) {
                    await BotManager.sendMessage(userId, msg);
                }
            }
        });
    } catch (error) {
        console.error(`Error en handleUserTimeout para ${userId}:`, error);
    }
};

//setUserState - Sistema para manejar los estados con los timeouts
const setUserState = (userId, newState) => {
    // Inicializar estado si no existe
    if (!globalStates[userId]) {
        globalStates[userId] = { 
            lastUpdated: Date.now(),
            createdAt: Date.now(),
            lastActivity: Date.now()
        };
    }

    // Mantener propiedades importantes si existen
    const importantProps = {
        enEncuesta: globalStates[userId]?.enEncuesta,
        currentQuestion: globalStates[userId]?.currentQuestion
    };

    // Actualizar estado
    globalStates[userId] = {
        ...globalStates[userId],
        ...importantProps,
        ...newState,
        lastUpdated: Date.now(),
        lastActivity: Date.now()
    };

    console.log(` Estado actualizado para ${userId}:`, JSON.stringify(globalStates[userId], null, 2));

    // Siempre establecer timeout para cualquier interacción
    clearUserTimeout(userId); // Limpiar timeout existente primero
    activeTimeouts.set(
        userId,
        setTimeout(() => handleUserTimeout(userId), 6 * 60 * 1000)
    );
};

const getUserState = (userId) => {
    return globalStates[userId] || {};
};


//Manejar las etiquetas que contengan Web Scraping
const manejarAccion = async (action, ctx, { flowDynamic }) => {
    const userId = ctx.from;
    const userState = getUserState(userId);
    const mensajeUsuario = ctx.body ? ctx.body.trim() : '';

    console.log("Acción recibida:", action);
    console.log("Mensaje recibido:", mensajeUsuario);
    console.log("Estado actual:", JSON.stringify(userState, null, 2));

    // Actualizar estado manteniendo propiedades importantes
    setUserState(userId, {
        currentAction: action,
        lastActivity: Date.now()
    });

    switch (action) {
        case "verificar_pago":
            if (userState.esperandoRecibo && /^\d+$/.test(mensajeUsuario)) {
                const numeroRecibo = mensajeUsuario;
                console.log("Número de recibo recibido:", numeroRecibo);

                await flowDynamic('⏳ Verificando el estado del pago, espera un momento...');

                try {
                    const resultado = await verificarPago(numeroRecibo);
                    
                    if (!resultado || resultado.estadoPago.includes("No disponible") || resultado.estadoPago.includes("No encontrado")) {
                        await flowDynamic("❌ No se encontró información del recibo. Verifica el número e intenta de nuevo:");
                        setUserState(userId, {
                            esperandoRecibo: true,
                            currentAction: "verificar_pago",
                            lastActivity: Date.now()
                        });
                    } else {
                        await flowDynamic([
                            `✅ *Pago verificado*\n👤 Nombre: *${resultado.nombrePersona}*\n📄 Estado: *${resultado.estadoPago}*\n¿En qué más puedo ayudarte?`
                        ]);
                        setUserState(userId, { 
                            currentAction: null,
                            lastActivity: Date.now()
                        });
                    }
                } catch (error) {
                    console.error("Error en la verificación:", error);
                    await flowDynamic("❌ Error al verificar el pago. Inténtalo más tarde.");
                    setUserState(userId, { 
                        currentAction: null,
                        lastActivity: Date.now()
                    });
                }
                return;
            } else {
                setUserState(userId, {
                    esperandoRecibo: true,
                    currentAction: "verificar_pago",
                    lastActivity: Date.now()
                });
                await flowDynamic('🔢 Por favor ingresa el número de recibo del PIN (solo números, sin letras ni espacios):');
                return;
            }

        case "consultar_admitido":
            if (userState.esperandoIdentificacion) {
                const identificacion = mensajeUsuario;
                
                if (!/^\d+$/.test(identificacion)) {
                    await flowDynamic("⚠️ Ingresa solo el número de identificación sin letras ni espacios.");
                    return;
                }

                await flowDynamic("⏳ Verificando si fuiste admitido, espera un momento...");

                try {
                    const resultado = await consultarAdmitido(identificacion);

                    if (resultado.listadoDisponible === false) {
                        await flowDynamic([
                            "📢 El listado de admitidos aún no está disponible.",
                            "📅 Consulta el *Calendario de Admisiones* para conocer la fecha exacta de publicación."
                        ]);
                        return;
                    }

                    const { nombrePersona, datos } = resultado;

                    if (!datos || datos.length === 0 || datos[0].programa === "No disponible") {
                        await flowDynamic([
                            "❌ No encontramos registros con ese número de identificación.",
                            "🔄 Si deseas intentarlo nuevamente, por favor ingresa tu número de identificación otra vez.",
                        ]);
                        return;
                    }

                    let mensaje = [
                        `✅ *Información de admisión*`,
                        `👤 *${nombrePersona}*`,
                        `\n🔹 *Detalles de admisión:*`
                    ];

                    datos.forEach((resultado, index) => {
                        mensaje.push(
                            `\n📚 Programa: *${resultado.programa}*\n📄 Estado: *${resultado.estado}*\n📄 Listado: *${resultado.listado}* \n📒 Matriculado: *${resultado.matriculado || 'No disponible'}*\n🔢 Opción: *${resultado.opcion}*\n📝 Observaciones: *${resultado.observaciones}*\n---------------------`
                        );
                    });

                    mensaje.push(`\n¿En qué más puedo ayudarte?`);

                    await flowDynamic(mensaje.join("\n"));

                } catch (error) {
                    console.error("Error en la verificación:", error);
                    await flowDynamic("❌ Error al verificar si fuiste admitido. Inténtalo más tarde.");
                } finally {
                    setUserState(userId, { 
                        currentAction: null,
                        lastActivity: Date.now()
                    });
                }
                return;

            } else {
                setUserState(userId, {
                    esperandoIdentificacion: true,
                    currentAction: "consultar_admitido",
                    lastActivity: Date.now()
                });
                await flowDynamic('🔢 Por favor ingresa tu número de identificación sin letras ni espacios:');
                return;
            }

        case "mostrar_programas":
            // Si ya está esperando una sede
            if (userState.esperandoSede) {
                const sedesValidas = ['pasto', 'tumaco', 'tuquerres', 'ipiales', '1', '2', '3', '4'];
                const mensajeLower = mensajeUsuario.toLowerCase();
                
                // Verificar si es una sede válida
                if (sedesValidas.includes(mensajeLower)) {
                    // Procesar la sede seleccionada
                    const programasPorSede = await extraerProgramasAcademicos();
                    const sedes = {
                        pasto: "PASTO", tumaco: "TUMACO", tuquerres: "TÚQUERRES", ipiales: "IPIALES",
                        "1": "PASTO", "2": "TUMACO", "3": "TÚQUERRES", "4": "IPIALES"
                    };
                    const sede = sedes[mensajeLower];
                    
                    if (sede && programasPorSede[sede]) {
                        const programasFormateados = programasPorSede[sede]
                            .map(programa => `- ${programa}`)
                            .join('\n');
                        
                        await flowDynamic(
                            `📚 *Programas en ${sede}:*\n${programasFormateados}\n\n` +
                            "🔄 ¿Quieres conocer otra sede? Escribe su nombre (ej: *Tumaco*).\n" +
                            "O escribe *salir* para preguntar por otro tema de interés."
                        );
                        
                        // Mantener el estado para permitir consultar otra sede
                        setUserState(userId, { 
                            esperandoSede: true, 
                            currentAction: "mostrar_programas",
                            lastActivity: Date.now()
                        });
                        return;
                    }
                }
                // Si no es una sede válida, verificar si quiere salir o es otra consulta
                else if (mensajeLower === 'salir') {
                    setUserState(userId, {
                        esperandoSede: false,
                        currentAction: null,
                        lastActivity: Date.now()
                    });
                    await flowDynamic("¡Espero que la información sobre los programas de la Universidad de Nariño te haya sido útil! \nSi tienes alguna otra pregunta, no dudes en decírmelo. Estoy aquí para ayudarte. 😊");
                    return;
                }
                else {
                    // Consultar si el mensaje es otra intención
                    const intent = await consultarIntencion(mensajeUsuario);
                    
                    // Si es una intención diferente, limpiar estado y manejar la nueva acción
                    if (intent.action && intent.action !== "mostrar_programas") {
                        setUserState(userId, {
                            esperandoSede: false,
                            currentAction: null,
                            lastActivity: Date.now()
                        });
                        return await manejarAccion(intent.action, ctx, { flowDynamic });
                    }
                    // Si no es una intención reconocida, seguir pidiendo la sede
                    else {
                        await flowDynamic([
                            "No entendí tu respuesta. Por favor selecciona una sede:\n" +
                            "🏫 *Opciones:*\n1. Pasto\n2. Tumaco\n3. Túquerres\n4. Ipiales\n\n" +
                            "Por favor, escribe el nombre o número de la sede que te interesa, o escribe salir si deseas consultar otro tema."
                        ]);
                        return;
                    }
                }
            }
            else {
                // Iniciar el flujo de programas por primera vez
                setUserState(userId, { 
                    esperandoSede: true, 
                    currentAction: "mostrar_programas",
                    lastActivity: Date.now()
                });
                await flowDynamic([
                    "🏫 *Selecciona la sede de la cual deseas conocer los programas académicos:*\n1. Pasto\n2. Tumaco\n3. Túquerres\n4. Ipiales\n\n" +
                    "Escribe el nombre o número:"
                ]);
                return;
            }
            break;

        case "mostrar_fechas":
            try {
                const fechasImportantes = await extraerFechasImportantes();
                
                if (typeof fechasImportantes === 'string') {
                    await flowDynamic(fechasImportantes);
                } else if (Array.isArray(fechasImportantes)) {
                    let mensaje = "📅 *Fechas importantes del proceso de inscripción y admisión:*\n\n";
                    fechasImportantes.forEach(item => {
                        mensaje += `🔹 *${item.proceso}*: ${item.fechas}\n\n`;
                    });
                    mensaje += "¿En qué más puedo ayudarte?";
                    await flowDynamic(mensaje);
                } else {
                    await flowDynamic("❌ Formato de fechas no reconocido.");
                }
                
                // Mantener el estado activo después de mostrar fechas
                setUserState(userId, {
                    currentAction: null,
                    lastActivity: Date.now()
                });
                console.log("Fechas mostradas, estado actual:", JSON.stringify(getUserState(userId), null, 2));
            } catch (error) {
                console.error("Error al obtener las fechas:", error);
                await flowDynamic("❌ Hubo un error al obtener las fechas importantes. Inténtalo más tarde.");
                setUserState(userId, {
                    currentAction: null,
                    lastActivity: Date.now()
                });
            }
            break;

        case "obtener_info_pin":
            try {
                await flowDynamic("Buscando información sobre el PIN de inscripción...");
                const pinInfo = await obtenerInfoPin();
                
                if (!pinInfo || !pinInfo.generacion) {
                    throw new Error("No se obtuvo información válida");
                }
                
                let respuesta = [
                `📌 *Información sobre el PIN de inscripción*\n${pinInfo.generacion}`,
                "¿En qué más puedo ayudarte?"
                ];

                await flowDynamic(respuesta);
                setUserState(userId, {
                    currentAction: null,
                    lastActivity: Date.now()
                });
            } catch (error) {
                console.error("Error en obtener_info_pin:", error);
                await flowDynamic([
                    "⚠️ No pude obtener la información en este momento",
                    "Por favor intenta más tarde o consulta en:",
                    "https://www.udenar.edu.co/requisitos-de-inscripcion/"
                ]);
                setUserState(userId, {
                    currentAction: null,
                    lastActivity: Date.now()
                });
            }
            break;

        case "calculo_ponderado":
                
            if (!userState.esperandoSedePonderado && !userState.sedeSeleccionadaPonderado) {
                setUserState(userId, { 
                    currentAction: "calculo_ponderado", 
                    esperandoSedePonderado: true,
                    lastActivity: Date.now()
                });
                await flowDynamic("🏫 Para realizar tu cálculo de ponderado, por favor ingresa la sede de tu interés. Las opciones disponibles son: Pasto, Ipiales, Túquerres y Tumaco.");
                return;
            }

            if (userState.esperandoSedePonderado) {
                setUserState(userId, { 
                    sedeSeleccionadaPonderado: mensajeUsuario,
                    esperandoSedePonderado: false,
                    esperandoTipoICFES: true,
                    lastActivity: Date.now()
                });
                
                // Construir mensaje con las opciones de ICFES
                let menuICFES = "📄 *Selecciona el tipo de ICFES que presentaste:*\n\n";
                for (const [numero, opcion] of Object.entries(OPCIONES_ICFES)) {
                    menuICFES += `${numero}. ${opcion.texto}\n`;
                }
                menuICFES += "\n✏️ Responde con el número correspondiente (ejemplo: 1)";
                
                await flowDynamic(menuICFES);
                return;
            }

            if (userState.esperandoTipoICFES) {
                // Validar que sea una opción numérica válida
                if (!OPCIONES_ICFES[mensajeUsuario]) {
                    await flowDynamic("⚠️ Opción no válida. Por favor, ingresa solo el número correspondiente al tipo de ICFES (1 al 5):");
                    return;
                }
                
                const opcionSeleccionada = OPCIONES_ICFES[mensajeUsuario];
                
                setUserState(userId, { 
                    tipoICFES: opcionSeleccionada.texto,
                    tipoICFESValue: opcionSeleccionada.value,
                    materiasICFES: opcionSeleccionada.materias,
                    minCalificaciones: opcionSeleccionada.minCalificaciones,
                    maxCalificaciones: opcionSeleccionada.maxCalificaciones,
                    esperandoTipoICFES: false,
                    esperandoCalificaciones: true,
                    lastActivity: Date.now()
                });
                
                // Mostrar instrucciones con las materias específicas
                let materiasMensaje = "📝 *Ingresa tus calificaciones en este orden* (separadas por comas):\n\n";
                opcionSeleccionada.materias.forEach((materia, index) => {
                    materiasMensaje += `${index + 1}. ${materia}\n`;
                });
                materiasMensaje += `\n🔢 Debes ingresar entre ${opcionSeleccionada.minCalificaciones} y ${opcionSeleccionada.maxCalificaciones} calificaciones.\n` +
                                "✏️ Ejemplo: 45, 50, 38, 42, 55";
                
                await flowDynamic(materiasMensaje);
                return;
            }

            if (userState.esperandoCalificaciones) {
                const calificaciones = mensajeUsuario.split(",")
                    .map(num => parseFloat(num.trim()))
                    .filter(num => !isNaN(num));
                    
                // Validar cantidad de calificaciones
                if (calificaciones.length < userState.minCalificaciones || 
                    calificaciones.length > userState.maxCalificaciones) {
                    await flowDynamic(
                        `⚠️ Cantidad incorrecta de calificaciones. Debes ingresar ` +
                        `${userState.minCalificaciones} números separados por comas.\n\n` +
                        `Por favor ingresa tus calificaciones nuevamente:`
                    );
                    return;
                }
                
                // Validar que todos sean números válidos
                if (calificaciones.some(isNaN)) {
                    await flowDynamic(
                        "⚠️ Formato incorrecto. Ingresa solo números separados por comas.\n" +
                        "Ejemplo: 45, 50, 38, 42, 55\n\n" +
                        "Por favor intenta nuevamente:"
                    );
                    return;
                }

                await flowDynamic("⏳ Calculando ponderado...");
                
                try {
                    const resultado = await calculoPonderado(
                        userState.sedeSeleccionadaPonderado, 
                        userState.tipoICFES, // Usamos el texto completo para registros
                        calificaciones
                    );
                    
                    await flowDynamic({
                        body: `✅ *Resultado del cálculo para ${userState.tipoICFES}:*\n\n${resultado}\n\n` +
                            "¿En qué más puedo ayudarte?",
                        delay: 1000
                    });
                } catch (error) {
                    console.error("Error en cálculo ponderado:", error);
                    await flowDynamic("❌ Hubo un error al calcular el ponderado. Por favor intenta nuevamente más tarde.");
                }

                // Limpiar estados
                setUserState(userId, {
                    sedeSeleccionadaPonderado: null,
                    tipoICFES: null,
                    tipoICFESValue: null,
                    materiasICFES: null,
                    minCalificaciones: null,
                    maxCalificaciones: null,
                    esperandoCalificaciones: false,
                    currentAction: null,
                    lastActivity: Date.now()
                });
                return;

            }
            break;
        default:
            console.log("Acción desconocida:", action);
            await flowDynamic([
                "⚠️ Opción no válida.",
            ]);
            setUserState(userId, {
                currentAction: null,
                lastActivity: Date.now()
            });
        break;
    }
};


// Función para limpiar estados antiguos (ejecutar periódicamente)
function limpiarEstadosInactivos() {
    const UMBRAL_INACTIVIDAD = 30 * 60 * 1000; // 30 minutos (aumentado)
    const ahora = Date.now();

    Object.entries(globalStates).forEach(([userId, state]) => {
        if (ahora - state.lastActivity > UMBRAL_INACTIVIDAD) {
            console.log(`Limpiando estado inactivo de ${userId}`);
            if (activeTimeouts.has(userId)) {
                clearTimeout(activeTimeouts.get(userId));
                activeTimeouts.delete(userId);
            }
            delete globalStates[userId];
        }
    });
}

// Ejecutar cada minuto
setInterval(limpiarEstadosInactivos, 60 * 1000);



/* SELCT EN POSTGRES DE LOS RESULTADOS DE LA ENCUESTA
-- Todas las respuestas de recomendación
SELECT * FROM mensajes 
WHERE mensaje LIKE '[ENCUESTA-RECOMENDACION]%'
ORDER BY fecha DESC;

-- Todas las respuestas de satisfacción
SELECT * FROM mensajes 
WHERE mensaje LIKE '[ENCUESTA-SATISFACCION]%'
ORDER BY fecha DESC;

-- Todos los comentarios
SELECT * FROM mensajes 
WHERE mensaje LIKE '[ENCUESTA-COMENTARIO]%'
ORDER BY fecha DESC;*/

async function Encuesta(ctx, { flowDynamic }) {
    const userId = ctx.from;
    const userState = getUserState(userId);
    const respuestaUsuario = ctx.body ? ctx.body.trim() : '';
    
    // Obtener el nombre del usuario del contexto o del estado si está disponible
    const nombreUsuario = ctx?.pushName || userState?.nombreUsuario || "Usuario";

    // Guardar el nombre en el estado si no estaba presente
    if (!userState.nombreUsuario && ctx?.pushName) {
        setUserState(userId, {
            ...userState,
            nombreUsuario: ctx.pushName
        });
    }

    const yaCompletoEncuesta = await usuarioYaRealizoEncuesta(userId);
    if (yaCompletoEncuesta && !userState.enEncuesta) {
        console.log(`ℹUsuario ${userId} ya completó la encuesta anteriormente`);
        return;
    }

    // Si no está en encuesta, iniciar una nueva
    if (!userState.enEncuesta) {
        setUserState(userId, {
            enEncuesta: true,
            currentQuestion: 'recomendacion',
            currentAction: 'encuesta',
            nombreUsuario: nombreUsuario  // Asegurarse de guardar el nombre
        });

        await flowDynamic([
            `📝 ${nombreUsuario}, nos ayudarías mucho respondiendo esta breve encuesta.`+ 
            '\n¿Qué tan probable es que recomiendes este servicio a otra persona?\n1: Muy improbable\n2: Poco probable\n3: Neutral\n4: Probable\n5: Muy probable'
        ]);
        return;
    }

    // Procesar respuestas de la encuesta
    switch (userState.currentQuestion) {
        case 'recomendacion':
            if (!/^[1-5]$/.test(respuestaUsuario)) {
                await flowDynamic('Por favor ingresa un número del 1 al 5:');
                return;
            }
            await guardarMensaje(userId, `[ENCUESTA-RECOMENDACION] ${respuestaUsuario}`);
            setUserState(userId, { currentQuestion: 'satisfaccion' });
            await flowDynamic([
                '📝 Ahora, ¿qué tan satisfecho quedaste con el servicio?\n1: Nada satisfecho\n2: Poco satisfecho\n3: Neutral\n4: Satisfecho\n5: Muy satisfecho'
            ]);
            return;

        case 'satisfaccion':
            if (!/^[1-5]$/.test(respuestaUsuario)) {
                await flowDynamic('Por favor ingresa un número del 1 al 5:');
                return;
            }
            await guardarMensaje(userId, `[ENCUESTA-SATISFACCION] ${respuestaUsuario}`);
            setUserState(userId, { currentQuestion: 'comentarios' });
            await flowDynamic('¿Tienes algún comentario o sugerencia para mejorar nuestro servicio? Danos tu respuesta a continuación o envíanos un "No" en caso de no tener comentarios.');
            return;

        case 'comentarios':
            if (respuestaUsuario.toLowerCase() !== 'no') {
                await guardarMensaje(userId, `[ENCUESTA-COMENTARIO] ${respuestaUsuario}`);
            }
            setUserState(userId, {
                enEncuesta: false,
                currentQuestion: null,
                currentAction: null,
                lastActivity: Date.now()
            });
            await flowDynamic([
                '✅ ¡Gracias por completar nuestra encuesta, tus respuestas han sido almacenadas en nuestra base de datos!\nTu opinión es muy valiosa para mejorar nuestro servicio.\n🎓 ¡Te deseamos muchos éxitos! 🙌🏽'
            ]);
            return;
    }
}

// Definir las opciones de ICFES directamente aquí
const OPCIONES_ICFES = {
    "1": {
        texto: "ICFES periodo A 2016 en adelante",
        value: "number:1",
        materias: ["Ciencias Naturales", "Matemáticas", "Inglés", "Lectura crítica", "Sociales y ciudadanía", "(Opcional) Prueba interna"],
        minCalificaciones: 5,
        maxCalificaciones: 6
    },
    "2": {
        texto: "ICFES periodo B de 2014 hasta periodo B de 2015",
        value: "number:2",
        materias: ["Lectura crítica", "Matemáticas", "Sociales y ciudadanía", "Ciencias Naturales", "Inglés", "Razonamiento cuantitativo", "Competencia ciudadana", "(Opcional) Prueba interna"],
        minCalificaciones: 7,
        maxCalificaciones: 8
    },
    "3": {
        texto: "ICFES entre 2006 y hasta periodo A de 2014",
        value: "number:3",
        materias: ["Biología", "Matemáticas", "Filosofía", "Física", "Química", "Lenguaje", "Inglés", "Sociales", "(Opcional) Prueba interna"],
        minCalificaciones: 8,
        maxCalificaciones: 9
    },
    "4": {
        texto: "ICFES entre 2000 y 2005",
        value: "number:4",
        materias: ["Biología", "Matemáticas", "Filosofía", "Física", "Historia", "Química", "Lenguaje", "Geometría", "Inglés", "(Opcional) Prueba interna"],
        minCalificaciones: 9,
        maxCalificaciones: 10
    },
    "5": {
        texto: "ICFES presentado en periodo B de 2010",
        value: "number:5",
        materias: ["Biología", "Matemáticas", "Filosofía", "Física", "Química", "Lenguaje", "Inglés", "Sociales", "(Opcional) Prueba interna"],
        minCalificaciones: 8,
        maxCalificaciones: 9
    }
};


// Diccionario para validar la cantidad de calificaciones según el tipo de ICFES
const reglasICFES = {
    "number:3": { min: 8, max: 9 }, // ICFES entre 2006 y hasta periodo A de 2014
    "number:2": { min: 7, max: 8 }, // ICFES periodo B de 2014 hasta periodo B de 2015
    "number:5": { min: 8, max: 9 }, // ICFES presentado en periodo B de 2010
    "number:1": { min: 5, max: 6 }, // ICFES periodo A 2016 en adelante
    "number:4": { min: 9, max: 10 } // ICFES entre 2000 y 2005
};

 // Diccionario para mapear nombres de ICFES a valores del select
const icfesMap = {
    "icfes entre 2006 y hasta periodo a de 2014": "number:3",
    "icfes periodo b de 2014 hasta periodo b de 2015": "number:2",
    "icfes presentado en periodo b de 2010": "number:5",
    "icfes periodo a 2016 en adelante": "number:1",
    "icfes entre 2000 y 2005": "number:4"
};

//Funcion para seleccionar e ifcfes
async function seleccionICFES(page, tipoICFES) {
    // Normalizar el texto del tipo de ICFES para comparación
    const tipoNormalizado = tipoICFES.toLowerCase().trim();

    // Buscar la clave que coincida parcialmente
    const icfesKey = Object.keys(icfesMap).find(key => 
        tipoNormalizado.includes(key)
    );

    if (!icfesKey) {
        console.error("Tipo de ICFES no válido:", tipoICFES);
        throw new Error("Tipo de ICFES no válido");
    }

    const icfesValue = icfesMap[icfesKey];
    console.log("Seleccionando ICFES:", tipoICFES, "→ Value:", icfesValue);

    try {
        // Verificar si el select existe
        const selectExists = await page.$('select[name="programa_id"]');
        if (!selectExists) {
            throw new Error("No se encontró el select[name='programa_id']");
        }

        // Simular clic en el select para asegurar que esté activo
        await page.click('select[name="programa_id"]');
      

        // Cambiar el valor y disparar eventos
        await page.evaluate((value) => {
            const select = document.querySelector('select[name="programa_id"]');
            if (select) {
                select.value = value;
                
                // Disparar todos los eventos necesarios
                const events = ['change', 'input', 'click'];
                events.forEach(eventType => {
                    select.dispatchEvent(new Event(eventType, { bubbles: true }));
                });
                
                // Manejo específico para AngularJS si es necesario
                if (typeof angular !== 'undefined') {
                    angular.element(select).triggerHandler('change');
                }
            }
        }, icfesValue);

        console.log(`ICFES seleccionado correctamente: ${icfesValue}`);

        // Esperar que la página cargue los inputs de calificaciones
        await new Promise(r => setTimeout(r, 2000));
            
        // Verificar si los inputs de calificaciones están visibles
        const inputs = await page.$$('input[type="text"], input[type="number"]');
        console.log(`Inputs encontrados después de seleccionar ICFES: ${inputs.length}`);

    } catch (error) {
        console.error("Error en seleccionICFES:", error);
        throw error;
    }
}

//WEB SCRAPING PARA CALCULAR EL PONDERADO
async function calculoPonderado(sede, tipoICFES, calificaciones) {
    const url = 'https://sapiens.udenar.edu.co:5032/';
    const browser = await puppeteer.launch({
        headless: false,
        slowMo: 50,
        devtools: true
    });
    const page = await browser.newPage();

    try {
        console.log("Abriendo la página...");
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        // 1. Seleccionar sede
        console.log("Seleccionando sede:", sede);
        await page.select('#sede_id', sede.toLowerCase());

        // 2. Seleccionar tipo de ICFES
        console.log("Seleccionando tipo de ICFES:", tipoICFES);
        const numInputs = await seleccionICFES(page, tipoICFES.toLowerCase());
        
        // Validar que coincida con lo esperado
        const expectedInputs = OPCIONES_ICFES[Object.keys(OPCIONES_ICFES).find(
            key => OPCIONES_ICFES[key].texto.toLowerCase() === tipoICFES.toLowerCase()
        )].maxCalificaciones;
        
        if (numInputs < expectedInputs) {
            throw new Error(`No se encontraron suficientes inputs (${numInputs} de ${expectedInputs})`);
        }
        
        // Ingresar las calificaciones segun el tipo de icfes
        console.log("Ingresando calificaciones...");

        await page.waitForSelector('.box-body', { timeout: 60000 });
        const inputs = await page.$$('.box-body input[ng-model]');

        console.log(`Inputs encontrados: ${inputs.length}`);

        if (inputs.length === 0) {
            console.log("No se encontraron inputs dentro de .box-body");
            return;
        }

        // Validar cantidad de calificaciones permitidas según el tipo de ICFES
        const { min, max } = reglasICFES[icfesMap[tipoICFES.toLowerCase().trim()]] || {};
        if (!min || !max) {
            console.error("No se encontraron reglas de calificaciones para este tipo de ICFES.");
            return;
        }

        console.log(`Se requieren entre ${min} y ${max} calificaciones para este ICFES.`);

        if (calificaciones.length < min || calificaciones.length > max) {
            console.error("Cantidad incorrecta de calificaciones. Se esperaban entre", min, "y", max, "pero se recibieron", calificaciones.length);
            return;
        }

        for (let i = 0; i < calificaciones.length; i++) {
            await inputs[i].click({ clickCount: 3 });
            await inputs[i].type(calificaciones[i].toString(), { delay: 50 });
            console.log(`Calificación ingresada: ${calificaciones[i]}`);
        }

        console.log("Calificaciones ingresadas correctamente.");
        
        // 4. Calcular
        console.log("Haciendo clic en calcular...");
        await page.click('button.btn.btn-success[ng-click="calcular_ponderados()"]');

        //  ESPERAR QUE LA TABLA SE GENERE CON DATOS
        await page.waitForFunction(() => {
            const tabla = document.querySelector(".table-responsive table tbody");
            return tabla && tabla.querySelectorAll("tr").length > 0;
        }, { timeout: 10000 });
            
        await new Promise(r => setTimeout(r, 3000));
        console.log("Cálculo realizado, extrayendo resultados...");
        
       // EXTRAER LOS RESULTADOS
        const resultados = await page.evaluate(() => {
            const tabla = document.querySelector(".table-responsive table");
            if (!tabla) return "❌ No se encontró la tabla.";

            return Array.from(tabla.querySelectorAll("tbody tr")).map(fila => {
                const columnas = fila.querySelectorAll("td");
                return {
                    programa: columnas[0]?.innerText.trim() || "No disponible",
                    oferta: columnas[1]?.innerText.trim() || "No disponible",
                    puntaje: columnas[2]?.innerText.trim() || "No disponible",
                    ultimoAdmitido: columnas[3]?.innerText.trim() || "No disponible",
                    semestres: columnas[4]?.innerText.trim() || "No disponible",
                };
            });
        });

        let mensaje = [];

        resultados.forEach((r) => {
            mensaje.push(
                `📘 ${r.programa}`,
                `📌 Oferta: ${r.oferta}`,
                `🎯 Puntaje obtenido: ${r.puntaje}`,
                `📉 Último admitido: ${r.ultimoAdmitido}`,
                `📚 Semestres: ${r.semestres}`,
                "---------------------"
            );
        });
        
        // Unir el array en un solo string con saltos de línea
        mensaje = mensaje.join("\n");
        return mensaje;
    } catch (error) {
        console.error("Error durante el proceso:", error);
        return "❌ Ocurrió un error durante el cálculo, inténtalo de nuevo más tarde.";
    } finally {
        await browser.close(); // Se ejecuta siempre, haya error o no
        
    }
}

//WEB SCRAPING PARA OBTENER INFORMACION SOBRE EL PIN DE INSCRIPCION - PRECIOS
async function obtenerInfoPin() {
    const url = 'https://www.udenar.edu.co/requisitos-de-inscripcion/';
  
    // Configuración de Puppeteer
    const browser = await puppeteer.launch({
      headless: false,  // Ver el proceso en el navegador
      slowMo: 50,       // Hacer más lento el proceso para verlo mejor
      devtools: true    // Abrir las herramientas de desarrollo
    });
    const page = await browser.newPage();
  
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
        // Esperar a que la opción "GENERACIÓN Y PAGO DE PIN DE INSCRIPCIÓN" esté disponible
        await page.waitForSelector('.ult_expheader', { visible: true, timeout: 60000 });
    
        // Hacer clic en la opción para desplegar la información
        await page.evaluate(() => {
            const headers = document.querySelectorAll('.ult_expheader');
            headers.forEach(header => {
            if (header.innerText.includes('GENERACIÓN Y PAGO DE PIN DE INSCRIPCIÓN')) {
                header.click(); // Hacer clic en el header correcto
            }
            });
        });
  
        // Esperar a que el contenido desplegado esté visible
        await page.waitForSelector('.ult_exp_content.ult_active_section', { visible: true, timeout: 60000 });
    
        // Extraer el contenido de la página
        const pinInfo = await page.evaluate(() => {
            // Seleccionar el elemento que contiene la información
            const contenido = document.querySelector('.ult_exp_content.ult_active_section');
    
            // Extraer el texto del elemento
            const generacionPin = contenido?.innerText.trim();
            return {
            generacion: generacionPin || 'No se encontró información sobre la generación y costos del PIN',
            };
        });
      // Retornar la información para usarla en otro lugar
        return pinInfo;
    } catch (error) {
    console.error('Error durante el scraping:', error);
    return {
        generacion: 'Error al obtener la información sobre la generación y costos del PIN',
    };
    } finally {
    await browser.close();
    }
}
  
    
//EXTARER PROGRAMAS ACADEMICOS DEL PDF
async function extraerProgramasAcademicos() {
    const pdfPath = "datos/CALENDARIO-ADMISIONES.pdf";
    try {
        const dataBuffer = fs.readFileSync(pdfPath);
        const data = await pdf(dataBuffer);

        const programasRegex = /PROGRAMAS EN (PASTO|IPIALES|TÚQUERRES|TUMACO)\s*\n([\s\S]*?)(?=\n\||\n\d+\.|\nPROGRAMAS EN|\n\n|$)/g;
        const programasPorSede = {};
        let match;

        while ((match = programasRegex.exec(data.text)) !== null) {
            const sede = match[1];
            const programas = match[2]
                .split('\n')
                .map(linea => linea.trim())
                .filter(linea => 
                    linea.length > 0 && 
                    !linea.match(/^[\d\.]+$/) &&
                    !linea.includes('Recepción de Reclamos') &&
                    !linea.includes('electrónico:') &&
                    !linea.includes('Nota:') &&
                    !linea.includes('PROCESO DE RECLAMACIÓN')
                );
            
            programasPorSede[sede] = programas; // Guarda como ARRAY
        }
        return programasPorSede;
    } catch (error) {
        console.error("Error al procesar el PDF:", error);
        return {};
    }
}

//EXTARER FECHAS IMPORTANTES DEL PFD
async function extraerFechasImportantes() {
    const pdfPath = "datos/CALENDARIO-ADMISIONES.pdf";

    try {
        const dataBuffer = fs.readFileSync(pdfPath);
        const data = await pdf(dataBuffer);
        const text = data.text.replace(/\s{2,}/g, ' ').replace(/\n/g, ' ');

        function normalizarFecha(fecha) {
        return fecha
            .toLowerCase()
            .replace(/\b[a-z]/g, l => l.toUpperCase())
            .replace(/\bDe\b/g, 'de');
        }

        const patrones = [
            {
                proceso: "GENERACIÓN Y PAGO DE PIN DE INSCRIPCIÓN",
                regex: /generaci[oó]n y pago de pin[\s\S]*?(\d{1,2}\s+de\s+\w+)\s+(?:hasta el|al)\s+(\d{1,2}\s+de\s+\w+\s+de\s+\d{4})[\s\S]*?Hasta las\s+(\d{1,2}:\d{2}\s*[ap]\.m\.)/i
            },
            {
                proceso: "DILIGENCIAMIENTO DE FORMULARIO",
                regex: /diligenciamiento de formulario[\s\S]*?(\d{1,2}\s+de\s+\w+)\s+(?:hasta el|al)\s+(\d{1,2}\s+de\s+\w+\s+de\s+\d{4})[\s\S]*?Hasta las\s+(\d{1,2}:\d{2}\s*[ap]\.m\.)/i      
            },
            {
                proceso: "EXÁMENES DE CUPOS ESPECIALES",
                regex: /ex[aá]menes de cupos especiales.*?(\d{1,2}\s+de\s+\w+\s+de\s+\d{4}).*?(\d{1,2}:\d{2}\s*a\.m\.)/i
            },
            {
                proceso: "PROCESO DE SUBSANACIÓN DE DOCUMENTOS",
                regex: /subsanaci[oó]n de documentos[\s\S]*?(\d{1,2}\s+de\s+\w+)\s+(?:hasta el|al)\s+(\d{1,2}\s+de\s+\w+\s+de\s+\d{4})[\s\S]*?Hasta las\s+(\d{1,2}:\d{2}\s*[ap]\.m\.)/i      
            },
            {
                proceso: "PUBLICACIÓN DE LISTADO DE ADMITIDOS",
                regex: /publicaci[oó]n de listado de admitidos.*?(\d{1,2}\s+de\s+\w+\s+de\s+\d{4})/i
            },
            {
                proceso: "MATRÍCULA PRIMER CORTE DE ADMITIDOS",
                regex: /MATR[IÍ]CULA PRIMER CORTE DE ADMITIDOS[\s\S]*?Del\s+(\d{1,2})\s+al\s+(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})[\s\S]*?Hasta las\s+(\d{1,2}:\d{2}\s*[ap]\.m\.)/i
            },
            {
                proceso: "PLAZO ADICIONAL MATRÍCULA PRIMER CORTE",
                regex: /plazo adicional.*?(\d{1,2}\s+de\s+\w+\s+de\s+\d{4}).*?Hasta las\s+(\d{1,2}:\d{2}\s*[ap]\.m\.)/i
            },
            {
                proceso: "PAGO DE MATRÍCULA PRIMER CORTE",
                regex: /pago de derechos.*?hasta el\s+(\d{1,2}\s+de\s+\w+\s+de\s+\d{4}).*?Hasta las\s+(\d{1,2}:\d{2}\s*[ap]\.m\.)/i
            },
            {
                proceso: "PUBLICACIÓN SEGUNDO CORTE DE ADMITIDOS",
                regex: /publicaci[oó]n segundo corte.*?(\d{1,2}\s+de\s+\w+\s+de\s+\d{4})/i
            },
            {
                proceso: "MATRÍCULA SEGUNDO CORTE DE ADMITIDOS",
                regex: /matr[ií]cula segundo corte.*?Del\s+(\d{1,2})\s+al\s+(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4}).*?Hasta las\s+(\d{1,2}:\d{2}\s*[ap]\.m\.)/i
            },
            {
                proceso: "PLAZO ADICIONAL MATRÍCULA SEGUNDO CORTE",
                regex: /plazo adicional.*?(\d{1,2}\s+de\s+\w+\s+de\s+\d{4}).*?Hasta las\s+(\d{1,2}:\d{2}\s*[ap]\.m\.)/i
            },
            {
                proceso: "PAGO DE MATRÍCULA SEGUNDO CORTE",
                regex: /Plazo para Pagar el Recibo de Matrícula[\s\S]*?(\d{1,2}\s+de\s+\w+\s+de\s+\d{4}).*?Hasta las\s+(\d{1,2}:\d{2}\s*[ap]\.m\.)/i
            },
            {
                proceso: "PUBLICACIÓN TERCER CORTE DE ADMITIDOS",
                regex: /publicaci[oó]n tercer corte.*?(\d{1,2}\s+de\s+\w+\s+de\s+\d{4})/i
            },
            {
                proceso: "MATRÍCULA TERCER CORTE DE ADMITIDOS",
                regex: /matr[ií]cula tercer corte.*?Del\s+(\d{1,2})\s+al\s+(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4}).*?Hasta las\s+(\d{1,2}:\d{2}\s*[ap]\.m\.)/i
            },
            {
                proceso: "PAGO DE MATRÍCULA TERCER CORTE",
                regex: /matr[ií]cula tercer corte.*?Plazo para Pagar el Recibo de Matrícula[\s\S]*?(\d{1,2}\s+de\s+\w+\s+de\s+\d{4}).*?Hasta las\s+(\d{1,2}:\d{2}\s*[ap]\.m\.)/i
            },
            {
                proceso: "INICIO DE ACTIVIDADES ACADÉMICAS (MEDICINA)",
                regex: /programa de medicina.*?(\d{1,2}\s+de\s+\w+\s+de\s+\d{4})/i
            },
            {
                proceso: "INICIO DE ACTIVIDADES ACADÉMICAS (OTROS PROGRAMAS)",
                regex: /todos los programas.*?(\d{1,2}\s+de\s+\w+\s+de\s+\d{4})/i
            },
            {
                proceso: "FINALIZACIÓN DE ACTIVIDADES ACADÉMICAS",
                regex: /finalizaci[oó]n de clases.*?(\d{1,2}\s+de\s+\w+\s+de\s+\d{4})/i
            }
        ];  

        const resultados = [];

        for (const { proceso, regex } of patrones) {
            const match = text.match(regex);
            if (match) {
                if (proceso.includes("INICIO DE ACTIVIDADES ACADÉMICAS")) {
                const tipo = proceso.includes("MEDICINA") ? "Medicina" : "Otros programas";
                resultados.push({
                    proceso: "INICIO DE ACTIVIDADES ACADÉMICAS",
                    fecha: normalizarFecha(match[1]),
                    tipo
                });
                } else if (proceso === "MATRÍCULA PRIMER CORTE DE ADMITIDOS" && match.length === 6) {
                const desde = `${match[1]} de ${match[3]} de ${match[4]}`;
                const hasta = `${match[2]} de ${match[3]} de ${match[4]}`;
                resultados.push({
                    proceso,
                    fecha: `Del ${normalizarFecha(desde)} al ${normalizarFecha(hasta)}\nHasta las ${match[5]}`
                });
                } else if (match.length === 4) {
                const fecha = `${normalizarFecha(match[1])} hasta el ${normalizarFecha(match[2])} de ${match[3]}.\nHasta las ${match[4]}`;
                resultados.push({ proceso, fecha });
                } else if (match.length === 3) {
                const fecha = `${normalizarFecha(match[1])}\nHasta las ${match[2]}`;
                resultados.push({ proceso, fecha });
                } else if (match.length === 2) {
                resultados.push({ proceso, fecha: normalizarFecha(match[1]) });
                }
            }
        }

        // Armar mensaje
        let mensaje = "📅 Fechas importantes del proceso de inscripción y admisión:\n\n";
        const procesosUnicos = [...new Set(resultados.map(r => r.proceso))];

        procesosUnicos.forEach(proceso => {
            const items = resultados.filter(i => i.proceso === proceso);
            if (proceso === "INICIO DE ACTIVIDADES ACADÉMICAS") {
                const med = items.find(i => i.tipo === "Medicina");
                const otros = items.find(i => i.tipo === "Otros programas");
                mensaje += `🔹 ${proceso}: ${med?.fecha || "No encontrada"} (Medicina), ${otros?.fecha || "No encontrada"} (Otros programas)\n`;
            } else {
                mensaje += `🔹 ${proceso}: ${items[0].fecha}\n`;
            }
        });
        return mensaje;
    } catch (error) {
        console.error("Error al procesar el PDF:", error);
        return "❌ Ocurrió un error al procesar el documento.";
    }
}
  
//WEB SCRAPING PARA CONSULTAR LA ADMISION
async function consultarAdmitido(identificacion) {
    //const browser = await puppeteer.launch({ headless: true });
    const browser = await puppeteer.launch({
        headless: false,  // Ver el proceso
        slowMo: 50,
        devtools: true
    });
    const page = await browser.newPage();

    try {
        console.log("Iniciando consulta...");
        await page.goto("https://sapiens.udenar.edu.co:5033/#/consultaadm", {waitUntil: "networkidle2", timeout: 240000});

        // 🔍 Verificar si el mensaje de “El listado será publicado...” está presente
        const mensajeVisible = await page.evaluate(() => {
            const div = document.querySelector("div.card-body p");
            return div && div.innerText.includes("El listado de admitidos será publicado según calendario");
        });

        if (mensajeVisible) {
            return {
                listadoDisponible: false
            };
        }


        // Esperar un poco para asegurar carga
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Seleccionar la opción antes de ingresar el número
        const radioSelector = "#customRadioInline2";
        await page.waitForSelector(radioSelector, { timeout: 10000 });
        await page.click(radioSelector);

        // Escribir el número de identificación
        const inputSelector = "#input-4";
        await page.waitForSelector(inputSelector, { timeout: 10000 });
        await page.type(inputSelector, identificacion);

        // Clic en el botón de consulta
        const buttonSelector = ".btn.btnSave";
        await page.waitForSelector(buttonSelector, { timeout: 10000 });
        await page.click(buttonSelector);

        //Esperar a que la tabla con los resultados aparezca
        const tableSelector = ".ui-table-tbody tr";
        console.log("Esperando resultados...");
        await page.waitForSelector(tableSelector, { timeout: 15000 });

        //Extraer el nombre de la persona
        const nombrePersona = await page.evaluate(() => {
            const nombreElement = document.querySelector(".card-header.layout");
            return nombreElement ? nombreElement.innerText.trim() : "No disponible";
        });

        // Extraer información de la tabla
        const datos = await page.evaluate(() => {
            const filas = document.querySelectorAll(".ui-table-tbody tr");
            if (!filas.length) return [];

            return Array.from(filas).map(fila => {
                const columnas = fila.querySelectorAll("td");
                return {
                    programa: columnas[0]?.innerText.trim() || "No disponible",
                    estado: columnas[1]?.innerText.trim() || "No disponible",
                    listado: columnas[2]?.innerText.trim() || "No disponible",
                    matriculado: columnas[3]?.innerText.trim() || "No disponible",
                    opcion: columnas[4]?.innerText.trim() || "No disponible",
                    observaciones: columnas[5]?.innerText.trim() || "No disponible",
                };
            });
        });

        console.log("Datos obtenidos:", { nombrePersona, datos });
        return { nombrePersona, datos };
    } catch (error) {
        console.error("Error en el scraping:", error);
        return { nombrePersona: "No disponible", datos: [{ programa: "No disponible" }] };
    } finally {
        await browser.close();
    }
}
  
  
//Web Scraping para los estados de pago del pin  
async function verificarPago(numeroRecibo) {
    console.log(`Verificando recibo: ${numeroRecibo}`);

    const browser = await puppeteer.launch({
        headless: false,  // Ver el proceso
        slowMo: 50,
        devtools: true
    });
    const page = await browser.newPage();

    try {
        console.log(" Abriendo la página...");
        await page.goto('https://apoteca.udenar.edu.co/verificarpago/', { waitUntil: 'domcontentloaded' });

        // Ingresar el número de recibo
        console.log("Ingresando número de recibo...");
        const inputSelector = '#recibo';
        await page.waitForSelector(inputSelector, { timeout: 10000 });
        await page.type(inputSelector, numeroRecibo);

        // Hacer clic en el botón de consulta
        console.log("Haciendo clic en el botón...");
        const buttonSelector = '.btn.btn-lg.btn-success.btn-block';
        await page.waitForSelector(buttonSelector, { timeout: 10000 });
        await page.click(buttonSelector);

        // Esperar que aparezca la tabla con los resultados
        const tablaSelector = 'table tbody tr';
        console.log(" Esperando que aparezca la tabla...");
        await page.waitForSelector(tablaSelector, { timeout: 30000 });

        // Seleccionar los datos dentro de la tabla
        console.log("Extrayendo datos...");
        const resultado = await page.evaluate(() => {
            const fila = document.querySelector('table tbody tr');
            if (!fila) {
                console.log("No se encontró la tabla.");
                return { nombrePersona: 'No encontrado', estadoPago: 'No encontrado' };
            }

            const columnas = fila.querySelectorAll('td');
            return {
                nombrePersona: columnas[1]?.innerText.trim() || 'No disponible',
                estadoPago: columnas[4]?.innerText.trim() || 'No disponible'
            };
        });
        await browser.close();
        return resultado;
    } catch (error) {
        console.error("Error al verificar el pago:", error);
        await browser.close();
        return { estadoPago: '❌ No se pudo verificar el pago.', nombrePersona: '' };
    }
}

// Función para procesar audios de WhatsApp
const procesarAudio = async (msg) => {
    if (!msg || !msg.message || (!msg.message.audioMessage && !msg.message.voiceMessage)) {
    console.error("procesarAudio llamado sin mensaje de audio válido");
    return;
    }
    
    try {
        const buffer = await downloadMediaMessage(msg, "buffer", {});
        const audioDir = path.join(__dirname, "audios");
        if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir);

        const filename = `${msg.key.id}.oga`;
        const pathArchivo = path.join(audioDir, filename);
        fs.writeFileSync(pathArchivo, buffer);

        const form = new FormData();
        form.append("audio", fs.createReadStream(pathArchivo));

        const res = await axios.post("http://localhost:5002/audio", form, {
        headers: form.getHeaders(),
        });

        const transcripcion = res.data?.transcripcion || "No se pudo transcribir.";

        fs.unlinkSync(pathArchivo);

        return transcripcion;
    } catch (err) {
        console.error("Error al procesar audio:", err);
        return null;
    }
};

const ejecutar = async () => {
    const texto = await procesarAudio('./audios/audio1.ogg');
    console.log("Texto transcrito:", texto);
};

ejecutar();


// Configuración del adaptador de base de datos
const adapterDB = new PostgreSQLAdapter({
    host: process.env.POSTGRES_DB_HOST,
    user: process.env.POSTGRES_DB_USER,
    database: process.env.POSTGRES_DB_NAME,
    password: process.env.POSTGRES_DB_PASSWORD,
    port: process.env.POSTGRES_DB_PORT,
});

// Inicializar el proveedor y el bot

const main = async () => {
    const adapterProvider = createProvider(BaileysProvider);
    // Inicializar BotManager
    BotManager.init(adapterProvider);

    // Crear el bot pero desactivaremos su manejo automático de mensajes
    const bot = createBot({
        provider: adapterProvider,
        database: adapterDB,
    });

    // Desactivar completamente el manejador de mensajes del bot
    adapterProvider.removeAllListeners('message');

    // Nuestro propio manejador de mensajes
    adapterProvider.on('message', async (ctx) => {
        const telefono = ctx?.from?.includes('@') ? ctx.from : `${ctx.from}@s.whatsapp.net`;
        if (!telefono) return;

        const mensaje = ctx.message || {};
        const tiposNoPermitidos = [
            'imageMessage',
            'videoMessage',
            'documentMessage',
            'stickerMessage',
            'contactMessage',
            'locationMessage',
            'liveLocationMessage',
            'pollCreationMessage'
        ];

        // 1. Primero verificar si es un tipo no permitido
        const tipoDetectado = Object.keys(mensaje).find((k) => tiposNoPermitidos.includes(k));
        if (tipoDetectado) {
            console.log(`Mensaje bloqueado (${tipoDetectado}) de ${telefono}`);
            await adapterProvider.sendText(
                telefono,
                "❌ Solo se permiten mensajes de texto o notas de voz.\nNo se permiten documentos, imágenes, videos ni stickers."
            );
            return; // Salir inmediatamente si es un tipo no permitido
        }

        // 2. Solo procesar si es texto o audio válido
        const mensajeTexto = ctx?.body || '';
        const esNotaDeVoz = !!ctx?.message?.audioMessage || !!ctx?.message?.voiceMessage;
        
        if (typeof mensajeTexto !== 'string' || (!mensajeTexto.trim() && !esNotaDeVoz)) {
            return; // Ignorar mensajes vacíos o no válidos
        }

        try {
            let textoProcesar = mensajeTexto;
            
            if (esNotaDeVoz) {
                console.log("Nota de voz recibida de", telefono);
                const transcripcion = await procesarAudio(ctx);
                
                if (!transcripcion) {
                    await adapterProvider.sendText(telefono, "❌ No se pudo transcribir el audio.");
                    return;
                }
                
                console.log("Transcripción:", transcripcion);
                textoProcesar = transcripcion;
            }

            // Obtener el estado del usuario
            const userState = getUserState(telefono);
            const nombreUsuario = ctx.pushName || userState?.nombreUsuario || "Usuario";

            // Guardar mensaje en DB
            await guardarMensaje(telefono, textoProcesar);

            // Actualizar estado
            setUserState(telefono, {
                ...userState,
                lastActivity: Date.now(),
                nombreUsuario: ctx.pushName || userState?.nombreUsuario
            });

            // 1. Verificar si está en encuesta
            if (userState?.enEncuesta) {
                return await Encuesta({
                    ...ctx,
                    body: textoProcesar,
                    from: telefono,
                    pushName: nombreUsuario
                }, { 
                    flowDynamic: async (msgs) => {
                        for (const msg of Array.isArray(msgs) ? msgs : [msgs]) {
                            await adapterProvider.sendText(telefono, msg.body || msg);
                        }
                    }
                });
            }
            
            // 2. Verificar si hay acción en curso
            if (userState?.currentAction) {
                return await manejarAccion(userState.currentAction, {
                    ...ctx,
                    body: textoProcesar,
                    from: telefono,
                    pushName: nombreUsuario
                }, { 
                    flowDynamic: async (msgs) => {
                        for (const msg of Array.isArray(msgs) ? msgs : [msgs]) {
                            await adapterProvider.sendText(telefono, msg.body || msg);
                        }
                    }
                });
            }
            
            // 3. Consultar intención si no hay acción en curso
            const intent = await consultarIntencion(textoProcesar);

            if (intent.action) {
                // Si ya estábamos en medio de una acción diferente, limpiar primero
                if (userState?.currentAction && userState.currentAction !== intent.action) {
                    setUserState(telefono, {
                        esperandoSede: false,
                        esperandoIdentificacion: false,
                        esperandoRecibo: false,
                        esperandoCalificaciones: false,
                        currentAction: null,
                        lastActivity: Date.now()
                    });
                }
                
                // Manejar la nueva acción
                return await manejarAccion(intent.action, {
                    ...ctx,
                    body: textoProcesar,
                    from: telefono,
                    pushName: nombreUsuario
                }, { 
                    flowDynamic: async (msgs) => {
                        for (const msg of Array.isArray(msgs) ? msgs : [msgs]) {
                            await adapterProvider.sendText(telefono, msg.body || msg);
                        }
                    }
                });
            }

            // Si no hay acción pero es un saludo
            if (intent.tag === "saludo") {
                const mensajeCompleto = `¡Hola ${nombreUsuario}! 👋\n${intent.responses[0]}`;
                return await adapterProvider.sendText(telefono, mensajeCompleto);
            }

            // Respuesta normal para intenciones sin acción específica
            await adapterProvider.sendText(telefono, intent.responses[0]);

        } catch (error) {
            console.error('Error procesando mensaje:', error);
            await adapterProvider.sendText(telefono, "⚠️ Hubo un error al procesar tu solicitud.");
        }
    });

    QRPortalWeb({ provider: adapterProvider });
};

main();