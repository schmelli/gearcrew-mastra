#!/bin/bash
#
# Graph Gardener Deployment Script
# Deploys the latest code to geargraph.gearshack.app
#
# Usage: ./scripts/deploy.sh [--build-only] [--no-push]
#

set -e

# Configuration
SERVER="geargraph.gearshack.app"
USER="geargraphadmin"
REMOTE_PATH="/opt/memgraph/graph-gardener"
COMPOSE_PATH="/opt/memgraph/memgraph-platform"
CONTAINER_NAME="graph-gardener"
BRANCH="001-graph-gardening"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Parse arguments
BUILD_ONLY=false
NO_PUSH=false
for arg in "$@"; do
  case $arg in
    --build-only) BUILD_ONLY=true ;;
    --no-push) NO_PUSH=true ;;
  esac
done

echo -e "${GREEN}=== Graph Gardener Deployment ===${NC}"
echo "Server: $SERVER"
echo "Branch: $BRANCH"
echo ""

# Step 1: Git push (unless --no-push)
if [ "$NO_PUSH" = false ]; then
  echo -e "${YELLOW}[1/5] Pushing local changes to GitHub...${NC}"
  git push origin $BRANCH
  echo -e "${GREEN}✓ Push complete${NC}"
else
  echo -e "${YELLOW}[1/5] Skipping git push (--no-push)${NC}"
fi

# Check for sshpass
if ! command -v sshpass &> /dev/null; then
  echo -e "${RED}Error: sshpass is required. Install with: brew install hudochenkov/sshpass/sshpass${NC}"
  exit 1
fi

# Get password (prompt if not in env)
if [ -z "$DEPLOY_PASSWORD" ]; then
  echo -n "Enter SSH password for $USER@$SERVER: "
  read -s DEPLOY_PASSWORD
  echo ""
fi

SSH_CMD="sshpass -p '$DEPLOY_PASSWORD' ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password $USER@$SERVER"

# Step 2: Pull latest code on server
echo -e "${YELLOW}[2/5] Pulling latest code on server...${NC}"
eval "$SSH_CMD \"cd $REMOTE_PATH && git pull origin $BRANCH\""
echo -e "${GREEN}✓ Code updated${NC}"

# Step 3: Build container
echo -e "${YELLOW}[3/5] Building Docker container (this may take a few minutes)...${NC}"
eval "$SSH_CMD \"cd $COMPOSE_PATH && docker compose build $CONTAINER_NAME\""
echo -e "${GREEN}✓ Build complete${NC}"

if [ "$BUILD_ONLY" = true ]; then
  echo -e "${GREEN}=== Build complete (--build-only) ===${NC}"
  exit 0
fi

# Step 4: Restart container
echo -e "${YELLOW}[4/5] Restarting container...${NC}"
eval "$SSH_CMD \"docker stop $CONTAINER_NAME 2>/dev/null || true && docker rm $CONTAINER_NAME 2>/dev/null || true && cd $COMPOSE_PATH && docker compose up -d $CONTAINER_NAME\""
echo -e "${GREEN}✓ Container restarted${NC}"

# Step 5: Verify deployment
echo -e "${YELLOW}[5/5] Verifying deployment...${NC}"
sleep 3
eval "$SSH_CMD \"docker ps --filter name=$CONTAINER_NAME --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'\""

echo ""
echo -e "${GREEN}=== Deployment complete! ===${NC}"
echo "Container logs: docker logs -f $CONTAINER_NAME"
echo "API endpoint: https://geargraph.gearshack.app/api/system/status"
