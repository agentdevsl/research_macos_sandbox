#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="${IMAGE_NAME:-sandbox-claude}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

echo "Building sandbox image: ${IMAGE_NAME}:${IMAGE_TAG}"

docker build \
    -f Dockerfile.claude \
    -t "${IMAGE_NAME}:${IMAGE_TAG}" \
    .

echo "Image built successfully: ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""
echo "To test:"
echo "  docker run -d -p 2222:22 ${IMAGE_NAME}:${IMAGE_TAG}"
echo "  ssh -p 2222 root@localhost  # password: sandbox"
