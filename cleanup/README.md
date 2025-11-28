# Script de Limpieza de Sesiones

Script para limpiar automáticamente el archivo de sesiones (`session.json`) basándose en errores 403 encontrados en los logs del servicio notifier.

## Funcionalidades

1. **Obtiene logs del notifier** usando Docker
2. **Busca errores 403** en los logs y extrae los IDs de usuario afectados
3. **Elimina usuarios bloqueados** del archivo de sesiones
4. **Elimina duplicados** (mantiene solo la primera ocurrencia de cada ID)
5. **Crea un backup** del archivo antes de modificarlo
6. **Reinicia los servicios** bot y notifier después de la limpieza

## Uso Manual

### Ejecución Normal

```bash
cd /home/sgarcia/.local/gmbros.net/hetznerauctionbot
docker compose run --rm cleanup
```

### Modo Dry-Run (Prueba sin cambios)

Para probar el script sin hacer cambios reales:

```bash
docker compose run --rm cleanup --dry-run
```

O usando variable de entorno:

```bash
docker compose run --rm -e DRY_RUN=true cleanup
```

## Configuración en Cron

Para ejecutar el script automáticamente, puedes agregarlo a tu crontab. Ejemplo para ejecutarlo diariamente a las 3:00 AM:

```bash
# Editar crontab
crontab -e

# Agregar esta línea (ajusta la ruta según tu instalación):
0 3 * * * cd /home/sgarcia/.local/gmbros.net/hetznerauctionbot && docker compose run --rm cleanup >> /var/log/hetznerauctionbot_cleanup.log 2>&1
```

O si prefieres ejecutarlo cada 6 horas:

```bash
0 */6 * * * cd /home/sgarcia/.local/gmbros.net/hetznerauctionbot && docker compose run --rm cleanup >> /var/log/hetznerauctionbot_cleanup.log 2>&1
```

## Formato de Logs Esperado

El script busca líneas en los logs del notifier con el siguiente formato:

```
YYYY-MM-DD HH:mm:ss error: Error occurred for user USER_ID: 403
```

Donde `USER_ID` es el ID de sesión del usuario (formato: `user_id:user_id`).

## Archivos Generados

- **Backup**: Se crea un backup del archivo de sesiones antes de modificarlo en:
  ```
  volumes/hetznerauctionbot/app/data/session.json.backup.YYYY-MM-DDTHH-MM-SS
  ```

## Requisitos

- Docker y Docker Compose instalados
- El servicio `notifier` debe estar corriendo para obtener los logs
- Permisos de escritura en el directorio de datos del proyecto
- Acceso al socket de Docker (`/var/run/docker.sock`)

## Construcción de la Imagen

Para construir la imagen del servicio cleanup:

```bash
docker compose build cleanup
```

## Variables de Entorno

- `LOGLEVEL`: Nivel de logging (default: `info`)
- `PROJECT_DIR`: Directorio del proyecto (default: `/project`)
- `DRY_RUN`: Si se establece a `true`, no realizará cambios reales

