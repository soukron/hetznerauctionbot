// include requirements
const fs = require('fs'),
      path = require('path'),
      { execSync } = require('child_process'),
      winston = require('winston');

// configuration variables with default values
const loglevel = process.env.LOGLEVEL || 'info',
      session_input_file = process.env.SESSION_INPUT_FILE || 'data/session.json',
      project_dir = process.env.PROJECT_DIR || '/app',
      test_mode = process.env.TEST_MODE === 'true' || session_input_file.includes('.test.'),
      dry_run = process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run') || test_mode;

// Determinar archivo de salida: en modo test usar nomenclatura diferente para no sobreescribir el original
let session_output_file;
if (test_mode) {
  // En modo test, usar archivo de salida específico o generar uno basado en el de entrada
  if (process.env.SESSION_OUTPUT_FILE) {
    session_output_file = process.env.SESSION_OUTPUT_FILE;
  } else {
    // Generar nombre de archivo de salida basado en el de entrada
    const ext = path.extname(session_input_file);
    const base = session_input_file.slice(0, -ext.length);
    
    if (session_input_file.includes('.test.input.')) {
      // Si el input es .test.input.json, el output será .test.output.json
      session_output_file = session_input_file.replace('.test.input.', '.test.output.');
    } else if (session_input_file.includes('.test.')) {
      // Si ya tiene .test., agregar .output antes de la extensión
      session_output_file = `${base}.output${ext}`;
    } else {
      // Si no tiene .test., agregar .test.output antes de la extensión
      session_output_file = `${base}.test.output${ext}`;
    }
  }
} else {
  // En modo producción, usar el archivo especificado o el mismo que el input
  session_output_file = process.env.SESSION_OUTPUT_FILE || session_input_file;
}

// initialize logger
const logger = winston.createLogger({
  transports: [
    new winston.transports.Console({
      level: loglevel,
      handleExceptions: true,
      format: winston.format.combine(
        winston.format.timestamp({format: 'YYYY-MM-DD HH:mm:ss'}),
        winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`+(info.splat!==undefined? `${info.splat}.` : '.'))
      )
    })
  ]
});

// Helper function to get docker compose logs
const getNotifierLogs = () => {
  // En modo de prueba, leer desde archivo de prueba
  if (test_mode) {
    // Intentar diferentes rutas posibles para el archivo de logs de prueba
    const possiblePaths = [
      'data/test_logs.txt',
      'volumes/hetznerauctionbot/app/data/test_logs.txt',
      path.join(path.dirname(session_input_file), 'test_logs.txt')
    ];
    
    let testLogsFile = null;
    for (const testPath of possiblePaths) {
      if (fs.existsSync(testPath)) {
        testLogsFile = testPath;
        break;
      }
    }
    
    if (testLogsFile) {
      try {
        logger.info(`[TEST MODE] Leyendo logs de prueba desde: ${testLogsFile}`);
        return fs.readFileSync(testLogsFile, 'utf8');
      } catch (error) {
        logger.error(`Error leyendo logs de prueba: ${error.message}`);
        return '';
      }
    } else {
      logger.warn(`[TEST MODE] Archivo de logs de prueba no encontrado. Buscado en: ${possiblePaths.join(', ')}`);
      return '';
    }
  }

  // Modo producción: obtener logs del contenedor
  try {
    // Buscar el contenedor del notifier por nombre
    const containerId = execSync('docker ps -q -f "name=notifier" --filter "status=running"', {
      encoding: 'utf-8'
    }).trim();
    
    if (!containerId) {
      logger.warn('No se encontró el contenedor del notifier en ejecución');
      return '';
    }
    
    const logs = execSync(`docker logs --tail=1000 ${containerId} 2>&1`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return logs;
  } catch (error) {
    logger.error(`Error obteniendo logs del notifier: ${error.message}`);
    return '';
  }
};

// Extract user IDs with 403 errors from logs
const extractBlockedUsers = (logs) => {
  const blockedUsers = new Set();
  const lines = logs.split('\n');
  let currentUserId = null;

  for (const line of lines) {
    // Buscar líneas con "Error occurred for user"
    if (line.includes('Error occurred for user')) {
      // Extraer el ID del usuario (formato: "Error occurred for user ID: CODE")
      // El ID tiene formato "user_id:user_id" y puede estar seguido de ": 403" o ": CODE"
      const match = line.match(/Error occurred for user ([0-9]+:[0-9]+)[: ]/);
      if (match) {
        currentUserId = match[1].trim();
        
        // Verificar si esta línea contiene el código 403
        if (line.match(/403|Forbidden/i)) {
          if (currentUserId) {
            blockedUsers.add(currentUserId);
            currentUserId = null;
          }
        }
      }
    } else if (currentUserId && (line.match(/403|Forbidden/i))) {
      // El código 403 apareció en la línea siguiente
      blockedUsers.add(currentUserId);
      currentUserId = null;
    }
  }

  return Array.from(blockedUsers);
};

// Read session file
const readSessionFile = () => {
  try {
    const data = fs.readFileSync(session_input_file, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    logger.error(`Error leyendo archivo de sesiones: ${error.message}`);
    throw error;
  }
};

// Write session file
const writeSessionFile = (data) => {
  if (dry_run && !test_mode) {
    logger.info('[DRY-RUN] No se escribió el archivo de sesiones');
    return;
  }

  try {
    fs.writeFileSync(session_output_file, JSON.stringify(data, null, 2), 'utf8');
    if (test_mode) {
      logger.info(`[TEST MODE] Archivo de prueba escrito en: ${session_output_file}`);
      logger.info(`[TEST MODE] Archivo original NO modificado: ${session_input_file}`);
    } else {
      logger.info(`Archivo de sesiones actualizado: ${session_output_file}`);
    }
  } catch (error) {
    logger.error(`Error escribiendo archivo de sesiones: ${error.message}`);
    throw error;
  }
};

// Create backup
const createBackup = () => {
  if (test_mode) {
    logger.info('[TEST MODE] No se crea backup en modo de prueba');
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const backupFilename = `${session_output_file}.backup.${timestamp}`;

  if (dry_run) {
    logger.info(`[DRY-RUN] Se crearía backup en: ${backupFilename}`);
    return backupFilename;
  }

  try {
    fs.copyFileSync(session_input_file, backupFilename);
    logger.info(`Backup creado en: ${backupFilename}`);
    return backupFilename;
  } catch (error) {
    logger.error(`Error creando backup: ${error.message}`);
    throw error;
  }
};

// Clean session file
const cleanSessionFile = (blockedUsers) => {
  const data = readSessionFile();
  const sessions = data.sessions || [];
  const originalCount = sessions.length;

  // Eliminar usuarios bloqueados y duplicados
  const seenIds = new Set();
  const filteredSessions = [];
  const removedUsers = [];

  for (const session of sessions) {
    const sessionId = session.id || '';

    // Verificar si es un usuario bloqueado
    if (blockedUsers.includes(sessionId)) {
      removedUsers.push(sessionId);
      continue;
    }

    // Verificar duplicados (mantener solo el primero)
    if (seenIds.has(sessionId)) {
      logger.warn(`Eliminando duplicado: ${sessionId}`);
      continue;
    }

    seenIds.add(sessionId);
    filteredSessions.push(session);
  }

  // Actualizar datos
  data.sessions = filteredSessions;
  const finalCount = filteredSessions.length;
  const duplicatesRemoved = originalCount - removedUsers.length - finalCount;

  // Reportar resultados
  logger.info(`Usuarios bloqueados eliminados: ${removedUsers.length}`);
  if (removedUsers.length > 0) {
    removedUsers.forEach(userId => logger.info(`  - ${userId}`));
  }

  if (duplicatesRemoved > 0) {
    logger.info(`Duplicados eliminados: ${duplicatesRemoved}`);
  }

  logger.info(`Total de sesiones: ${originalCount} -> ${finalCount}`);

  return data;
};

// Restart services
const restartServices = () => {
  if (test_mode) {
    logger.info('[TEST MODE] No se reinician servicios en modo de prueba');
    return;
  }

  if (dry_run) {
    logger.info('[DRY-RUN] Se reiniciarían los servicios bot y notifier');
    return;
  }

  try {
    logger.info('Reiniciando servicios bot y notifier...');
    
    // Usar docker-compose restart para reiniciar SOLO los servicios específicos
    // Esto evita reiniciar otros contenedores como cleanup
    try {
      execSync('cd /project && docker compose restart bot notifier', {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 30000 // 30 segundos de timeout
      });
      logger.info('Servicios bot y notifier reiniciados correctamente usando docker-compose');
      return;
    } catch (composeError) {
      logger.warn(`docker-compose restart falló: ${composeError.message}`);
      logger.info('Intentando reinicio directo usando docker...');
    }
    
    // Fallback: usar docker directamente con labels de docker-compose
    // Esto garantiza que solo se reinicien los servicios específicos
    // y no otros contenedores (como cleanup)
    const currentContainerId = process.env.HOSTNAME || '';
    let restartedCount = 0;
    
    // Buscar y reiniciar solo el servicio bot usando su label específico
    try {
      const botContainer = execSync('docker ps -q -f "label=com.docker.compose.service=bot" --filter "status=running"', {
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim();
      
      if (botContainer && botContainer !== currentContainerId) {
        // Verificar que solo hay un contenedor bot (evitar múltiples coincidencias)
        const botContainers = botContainer.split('\n').filter(id => id && id !== currentContainerId);
        if (botContainers.length === 1) {
          execSync(`docker restart ${botContainers[0]}`, { stdio: 'pipe', timeout: 10000 });
          logger.info('Servicio bot reiniciado');
          restartedCount++;
        } else if (botContainers.length > 1) {
          logger.warn(`Se encontraron múltiples contenedores bot (${botContainers.length}), omitiendo reinicio por seguridad`);
        }
      } else if (!botContainer) {
        logger.warn('No se encontró el contenedor del bot en ejecución');
      }
    } catch (botError) {
      logger.warn(`Error al reiniciar bot: ${botError.message}`);
    }
    
    // Buscar y reiniciar solo el servicio notifier usando su label específico
    try {
      const notifierContainer = execSync('docker ps -q -f "label=com.docker.compose.service=notifier" --filter "status=running"', {
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim();
      
      if (notifierContainer && notifierContainer !== currentContainerId) {
        // Verificar que solo hay un contenedor notifier
        const notifierContainers = notifierContainer.split('\n').filter(id => id && id !== currentContainerId);
        if (notifierContainers.length === 1) {
          execSync(`docker restart ${notifierContainers[0]}`, { stdio: 'pipe', timeout: 10000 });
          logger.info('Servicio notifier reiniciado');
          restartedCount++;
        } else if (notifierContainers.length > 1) {
          logger.warn(`Se encontraron múltiples contenedores notifier (${notifierContainers.length}), omitiendo reinicio por seguridad`);
        }
      } else if (!notifierContainer) {
        logger.warn('No se encontró el contenedor del notifier en ejecución');
      }
    } catch (notifierError) {
      logger.warn(`Error al reiniciar notifier: ${notifierError.message}`);
    }
    
    if (restartedCount > 0) {
      logger.info(`Servicios reiniciados correctamente (${restartedCount} servicio(s))`);
    } else {
      logger.warn('No se reinició ningún servicio');
    }
  } catch (error) {
    logger.error(`Error al reiniciar los servicios: ${error.message}`);
    throw error;
  }
};

// Main function
const main = async () => {
  try {
    if (test_mode) {
      logger.warn('MODO PRUEBA: Usando archivos de prueba');
      logger.info(`Archivo de entrada: ${session_input_file}`);
      logger.info(`Archivo de salida: ${session_output_file}`);
    } else if (dry_run) {
      logger.warn('MODO DRY-RUN: No se realizarán cambios reales');
    }

    logger.info('Iniciando limpieza del archivo de sesiones...');

    // 1. Crear backup
    const backupFilename = createBackup();

    // 2. Obtener logs y extraer usuarios bloqueados
    logger.info('Obteniendo logs del servicio notifier...');
    const logs = getNotifierLogs();
    const blockedUsers = extractBlockedUsers(logs);

    if (blockedUsers.length === 0) {
      logger.info('No se encontraron usuarios con errores 403 en los logs recientes.');
    } else {
      logger.warn(`Se encontraron ${blockedUsers.length} usuario(s) con errores 403:`);
      blockedUsers.forEach(userId => logger.warn(`  - ${userId}`));
    }

    // 3. Limpiar archivo de sesiones
    logger.info('Procesando archivo de sesiones...');
    const cleanedData = cleanSessionFile(blockedUsers);

    // 4. Escribir archivo actualizado
    writeSessionFile(cleanedData);

    // 5. Reiniciar servicios
    restartServices();

    logger.info('Limpieza completada exitosamente');
    if (!dry_run && backupFilename) {
      logger.info(`Backup disponible en: ${backupFilename}`);
    }

    process.exit(0);
  } catch (error) {
    logger.error(`Error durante la limpieza: ${error.message}`);
    process.exit(1);
  }
};

// Run main function
main();

