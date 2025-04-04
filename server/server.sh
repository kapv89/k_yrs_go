#!/bin/bash

set -a
source .env
set +a

LD_LIBRARY_PATH=./db ./server --SERVER_HOST=$SERVER_HOST --SERVER_PORT=$SERVER_PORT --REDIS_URL=$REDIS_URL --PG_URL=$PG_URL --MODE=$MODE --DEBUG=$DEBUG --REDIS_QUEUE_MAX_SIZE=$REDIS_QUEUE_MAX_SIZE