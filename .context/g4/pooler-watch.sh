cd /home/boxes/rose/back-end; set -a; . ./.env; set +a; U="${DATABASE_URL%%\?*}"
while true; do r=$(timeout 20 psql "$U" -At -c 'select 1' 2>&1 | head -1 | cut -c1-40); echo "$(date -u +%FT%T) ${r}" >> /home/boxes/rose/.context/g4/pooler.log; [ "$r" = "1" ] && echo FREE >> /home/boxes/rose/.context/g4/pooler.log; sleep 60; done
