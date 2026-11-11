#!/usr/bin/env bash
# surge.sh <port> <delay_s> <sessions> <hold_s> <label> <files>: run unitpass.sh and, <delay_s> later,
# open <sessions> idle client sessions for <hold_s> seconds (a mid-test connection surge).
( sleep "$2"; /var/tmp/rca1947/hold.sh "$1" "$3" "$4" ) &
/var/tmp/rca1947/unitpass.sh "$1" "$5" "$6"
wait
