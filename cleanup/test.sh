#!/bin/bash

# Script de prueba para el servicio cleanup
# Este script ejecuta el cleanup en modo de prueba

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$PROJECT_DIR"

echo "=========================================="
echo "Ejecutando pruebas del servicio cleanup"
echo "=========================================="
echo ""

# Configurar variables de entorno para modo de prueba
export SESSION_INPUT_FILE="data/session.test.input.json"
export SESSION_OUTPUT_FILE="data/session.test.output.json"
export TEST_MODE="true"
export LOGLEVEL="info"

echo "Archivo de entrada: $SESSION_INPUT_FILE"
echo "Archivo de salida: $SESSION_OUTPUT_FILE"
echo ""

# Ejecutar el script de cleanup
echo "Ejecutando cleanup..."
node "$SCRIPT_DIR/index.js"

echo ""
echo "=========================================="
echo "Prueba completada"
echo "=========================================="
echo ""
echo "Comparar archivos:"
echo "  Entrada:  $SESSION_INPUT_FILE"
echo "  Salida:   $SESSION_OUTPUT_FILE"
echo ""

