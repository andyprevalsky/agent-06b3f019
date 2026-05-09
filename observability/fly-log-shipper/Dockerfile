FROM timberio/vector:0.55.0-debian

COPY vector-configs /etc/vector/
COPY start-fly-log-transporter.sh /usr/local/bin/start-fly-log-transporter.sh

CMD ["bash", "/usr/local/bin/start-fly-log-transporter.sh"]
ENTRYPOINT []
