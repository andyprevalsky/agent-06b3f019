#!/usr/bin/env bash
# hold.sh <port> <count> <seconds>: keep <count> idle client sessions open (stand-in for the coverage shards' Prisma pools)
for i in $(seq 1 "$2"); do psql "postgresql://postgres:postgres@localhost:$1/victoria" -qtAc "select pg_sleep($3)" >/dev/null 2>&1 & done
wait
